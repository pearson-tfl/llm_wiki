/**
 * Persistent serial queue for duplicate-merge operations.
 *
 * Why a queue (and not just kicking off `executeMerge` from the click
 * handler):
 *   - Merges rewrite cross-references across the entire wiki. Two
 *     concurrent merges race on the same files, last write wins, and
 *     half the rewrites silently disappear.
 *   - LLM calls take seconds; the user wants to queue several merges
 *     and walk away. The queue must survive app close so an
 *     interrupted merge resumes on next launch – after a resume click
 *     for a hand-queued merge, at once for a scheduled one.
 *
 * Mirrors `ingest-queue.ts` almost line-for-line: same lifecycle
 * (pause / restore on project switch), same persistence file shape,
 * same retry-up-to-3 policy, same registry-based path resolution so
 * a relocated project still finds its tasks. A merge reply that fails
 * its check is not retried automatically; enqueueing the group again
 * (the next scheduled scan does) resets the failed task.
 *
 * Merges and ingest never write at once (#24): no merge starts while
 * ingest is active, and a running merge holds the project write lock
 * that every ingest write takes.
 */
import { readFile, writeFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { executeMerge, reembedMergedPages } from "@/lib/dedup-runner"
import {
  ambiguousSlugRefusal,
  MergeReplyRejectedError,
  type DuplicateGroup,
  type MergeResult,
} from "@/lib/dedup"
import { listWikiPages, removePendingDuplicateGroup } from "@/lib/dedup-storage"
import { withProjectLock } from "@/lib/project-mutex"
import { isIngestActive } from "@/lib/ingest-queue"
import { reviewIdFor, useReviewStore } from "@/stores/review-store"

// ── Types ─────────────────────────────────────────────────────────────────

export interface DedupTask {
  id: string
  projectId: string
  group: DuplicateGroup
  canonicalSlug: string
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
  /** Enqueued by the scheduled maintenance job: runs without the resume
   *  click, including after a restore. */
  scheduled?: boolean
}

export type DedupTaskOutcome = "done" | "failed" | "rejected" | "cancelled" | "interrupted"

// ── State ─────────────────────────────────────────────────────────────────

let queue: DedupTask[] = []
let processing = false
/** Pending tasks restored from disk on startup/project open. These are
 * intentionally hydrated without auto-running so opening a project does
 * not immediately spend LLM tokens on historical merge work. Scheduled
 * tasks are not held here: the maintenance job queued them to run. A fresh
 * enqueue for the same group promotes the restored task out of this set. */
let restoredPausedTaskIds = new Set<string>()
let currentProjectId = ""
let currentProjectPath = ""
let currentAbortController: AbortController | null = null
/** Set while a merge waits for ingest to go idle; fires the next check. */
let ingestWaitTimer: ReturnType<typeof setTimeout> | null = null
/** Callers awaiting a scheduled task's outcome, and outcomes of scheduled
 *  tasks that settled before anyone awaited them. */
let outcomeWaiters = new Map<string, (outcome: DedupTaskOutcome) => void>()
let settledOutcomes = new Map<string, DedupTaskOutcome>()
/** The pause or restore now running. Project switches can overlap, so
 *  each waits for the one before to finish: a pause's clean-up never lands
 *  on the next project's queue, and a restore reads a file only once its
 *  save has landed (#39). */
let switchStepInFlight: Promise<void> | null = null

/** A pause is one queue-file write, and a restore at most two writes and a
 *  read, which take milliseconds; a step still running after this has hung
 *  (#43). */
export const SWITCH_STEP_TIMEOUT_MS = 30_000

export class SwitchStepTimeoutError extends Error {
  name = "SwitchStepTimeoutError"
}

/** The review option that retries a restore cut off by its time limit. */
export const RETRY_RESTORE_ACTION = "retry-dedup-queue-restore"

interface QueueRestore {
  projectId: string
  projectPath: string
  stillOpening: () => boolean
}

/** The restore last cut off by its time limit while its project was still
 *  the one opening, until a restore opens a project's queue (#48, #52). */
let timedOutRestore: QueueRestore | null = null

/**
 * Run a pause or restore once the one in flight has finished. One step
 * runs at a time, but not strictly in call order: a caller arriving
 * between two steps can go before one already waiting. A step must never
 * call `pauseQueue` or `restoreQueue` itself: it would wait for its own
 * finish for ever.
 *
 * A step still running after SWITCH_STEP_TIMEOUT_MS fails alone (#43): no
 * project is left open, its signal tells it to change nothing more when
 * its read or write settles, and the steps behind it run.
 */
async function oneSwitchStepAtATime(
  step: (abandoned: AbortSignal) => Promise<void>,
): Promise<void> {
  // A step that failed is its own caller's error, not the next step's.
  while (switchStepInFlight) await switchStepInFlight.catch(() => {})
  const abandon = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeLimit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandon.abort()
      stopActiveQueue()
      reject(new SwitchStepTimeoutError(
        `a project-switch pause or restore took over ${SWITCH_STEP_TIMEOUT_MS} ms; no project's merge queue is open`,
      ))
    }, SWITCH_STEP_TIMEOUT_MS)
  })
  const run = Promise.race([step(abandon.signal), timeLimit])
  switchStepInFlight = run
  try {
    await run
  } catch (err) {
    if (err instanceof SwitchStepTimeoutError) {
      console.error(`[Dedup Queue] ${err.name}: ${err.message}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (switchStepInFlight === run) switchStepInFlight = null
  }
}

function notifyScheduledOutcome(task: DedupTask, outcome: DedupTaskOutcome): void {
  if (!task.scheduled) return
  const waiter = outcomeWaiters.get(task.id)
  if (waiter) {
    outcomeWaiters.delete(task.id)
    waiter(outcome)
  } else {
    settledOutcomes.set(task.id, outcome)
  }
}

/** Resolve every waiting run as interrupted and forget unclaimed outcomes. */
function interruptScheduledWaiters(): void {
  for (const waiter of outcomeWaiters.values()) waiter("interrupted")
  outcomeWaiters = new Map()
  settledOutcomes = new Map()
}

/**
 * Resolve when a scheduled task leaves the running queue: merged, failed
 * for good, its merge reply rejected, cancelled, or interrupted by a
 * project switch.
 */
export function waitForTask(taskId: string): Promise<DedupTaskOutcome> {
  const settled = settledOutcomes.get(taskId)
  if (settled) {
    settledOutcomes.delete(taskId)
    return Promise.resolve(settled)
  }
  const task = queue.find((t) => t.id === taskId)
  if (!task?.scheduled) return Promise.resolve("interrupted")
  if (task.status === "failed") return Promise.resolve("failed")
  return new Promise((resolve) => outcomeWaiters.set(taskId, resolve))
}

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/dedup-queue.json`
}

/** Saves are stamped in the order they are made. A write that hangs can
 *  land after a later one, so each queue file keeps the newest save that
 *  has landed, to put back over an older one (#48). */
let lastSaveStamp = 0
let newestLandedSaves = new Map<string, { stamp: number; text: string }>()

async function saveQueue(
  projectPath: string,
  tasks: readonly DedupTask[] = queue,
): Promise<void> {
  try {
    const toSave = tasks.filter((t) => t.status !== "done")
    await writeNewestSave(
      queueFilePath(projectPath),
      ++lastSaveStamp,
      JSON.stringify(toSave, null, 2),
    )
  } catch {
    // non-critical
  }
}

async function writeNewestSave(path: string, stamp: number, text: string): Promise<void> {
  await writeFile(path, text)
  const newest = newestLandedSaves.get(path)
  if (newest && newest.stamp > stamp) {
    await writeNewestSave(path, newest.stamp, newest.text)
    return
  }
  newestLandedSaves.set(path, { stamp, text })
}

async function loadQueue(
  projectPath: string,
  projectId: string,
): Promise<DedupTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    const tasks = JSON.parse(raw) as DedupTask[]
    return tasks.map((t) => ({
      ...t,
      projectId: t.projectId ?? projectId,
    }))
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────

function generateId(): string {
  return `dedup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Stable key for matching a queued task to a UI card. Order-independent
 * lowercase join — same shape used by dedup-storage's canonical key.
 */
export function groupKey(slugs: readonly string[]): string {
  return [...slugs].map((s) => s.toLowerCase()).sort().join(",")
}

/**
 * Add a merge to the queue. The project MUST be the currently-active
 * project. Returns the new task's id. Idempotent on the same group:
 * if there's already a pending/processing/failed task for the same
 * slug-set, the existing id is returned instead of a duplicate.
 * `scheduled` marks a merge the scheduled maintenance job enqueued.
 */
export async function enqueueMerge(
  projectId: string,
  group: DuplicateGroup,
  canonicalSlug: string,
  options: { scheduled?: boolean } = {},
): Promise<string> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueMerge: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const key = groupKey(group.slugs)
  const existing = queue.find(
    (t) =>
      t.projectId === projectId &&
      t.status !== "done" &&
      groupKey(t.group.slugs) === key,
  )
  if (existing) {
    restoredPausedTaskIds.delete(existing.id)
    if (options.scheduled) existing.scheduled = true
    if (existing.status === "failed") {
      existing.status = "pending"
      existing.error = null
      existing.retryCount = 0
    }
    await saveQueue(currentProjectPath)
    processNext(currentProjectId)
    return existing.id
  }

  const task: DedupTask = {
    id: generateId(),
    projectId,
    group,
    canonicalSlug,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
    ...(options.scheduled ? { scheduled: true } : {}),
  }

  queue.push(task)
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
  return task.id
}

/**
 * A merge asked for on a Maintenance-screen card. A slug that names more
 * than one page would fail every retry of the merge, so it is refused here,
 * before any task is queued, in the merge's words, and the saved group
 * stays (#126). Otherwise the merge is queued and the saved group dropped.
 * Returns the refusal, or null once queued.
 */
export async function enqueueCardMerge(
  projectId: string,
  projectPath: string,
  group: DuplicateGroup,
  canonicalSlug: string,
): Promise<string | null> {
  const pages = await listWikiPages(projectPath)
  const refusal = group.slugs.map((slug) => ambiguousSlugRefusal(pages, slug)).find((r) => r !== null)
  if (refusal) return refusal
  await enqueueMerge(projectId, group, canonicalSlug)
  await removePendingDuplicateGroup(projectPath, group.slugs)
  return null
}

/**
 * Reset a failed task back to pending so it gets another shot. Clears
 * the error and resets retryCount so the user gets the full 3
 * attempts again.
 */
export async function retryTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  restoredPausedTaskIds.delete(task.id)
  task.status = "pending"
  task.error = null
  task.retryCount = 0
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
}

/** Resume merge tasks restored from disk during project open. */
export function resumeProcessing(): void {
  restoredPausedTaskIds.clear()
  if (currentProjectId) processNext(currentProjectId)
}

/**
 * Cancel/delete a task. If it's currently running, abort the LLM call
 * first — the merge writes will be left where they were when the
 * abort fired. Backup snapshots already on disk are kept either way.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  if (task.status === "processing") {
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
    processing = false
  }

  restoredPausedTaskIds.delete(taskId)
  queue = queue.filter((t) => t.id !== taskId)
  notifyScheduledOutcome(task, "cancelled")
  await saveQueue(currentProjectPath)
  processNext(currentProjectId)
}

export function getQueue(): readonly DedupTask[] {
  return queue
}

export function getQueueSummary(): {
  pending: number
  processing: number
  failed: number
  total: number
  restoredBacklogWaiting: boolean
} {
  return {
    pending: queue.filter((t) => t.status === "pending").length,
    processing: queue.filter((t) => t.status === "processing").length,
    failed: queue.filter((t) => t.status === "failed").length,
    total: queue.length,
    restoredBacklogWaiting: queue.some((t) =>
      t.status === "pending" && restoredPausedTaskIds.has(t.id)
    ),
  }
}

/**
 * Test-only: wipe in-memory state without touching disk. Production
 * code should always use `pauseQueue()` so pending state lands in
 * the right project's file before the slate is cleared.
 */
export function clearQueueState(): void {
  if (currentAbortController) {
    currentAbortController.abort()
  }
  queue = []
  restoredPausedTaskIds.clear()
  interruptScheduledWaiters()
  stopIngestWait()
  processing = false
  currentProjectId = ""
  currentProjectPath = ""
  currentAbortController = null
  switchStepInFlight = null
  timedOutRestore = null
  dismissRestoreTimeoutNotice()
  newestLandedSaves = new Map()
}

/**
 * Project-switch handshake: stop the active project's queue and clear its
 * in-memory state, then flush its tasks to disk (reverting any in-flight
 * task to pending so it gets re-tried on resume). Waits for a pause or
 * restore already in flight.
 */
export function pauseQueue(): Promise<void> {
  return oneSwitchStepAtATime(pauseActiveQueue)
}

async function pauseActiveQueue(): Promise<void> {
  if (!currentProjectId || !currentProjectPath) return

  const pausedProjectPath = currentProjectPath
  const pausedTasks = queue

  // No merge may start while the save below runs (#35), and a save that
  // settles after the step's time limit changes nothing in memory (#43).
  stopActiveQueue()
  for (const task of pausedTasks) {
    if (task.status === "processing") {
      task.status = "pending"
    }
  }
  await saveQueue(pausedProjectPath, pausedTasks)
}

/** Stop the open project's merge and forget its queue, saving nothing. */
function stopActiveQueue(): void {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
  processing = false
  currentProjectId = ""
  currentProjectPath = ""
  queue = []
  restoredPausedTaskIds.clear()
  interruptScheduledWaiters()
  stopIngestWait()
}

/**
 * Load a project's queue from disk. Restored pending tasks are visible
 * but do not auto-run, except scheduled ones, which run at once; a fresh
 * enqueue for the same group promotes the existing task, and retryTask
 * can also resume one explicitly. Waits for a pause or restore already in
 * flight, then does nothing if `stillOpening` says the project is no
 * longer the one being opened (#43). A project still open is paused
 * first: its merge stopped and its queue saved.
 */
export function restoreQueue(
  projectId: string,
  projectPath: string,
  stillOpening: () => boolean = () => true,
): Promise<void> {
  return restoreWhile({ projectId, projectPath, stillOpening }, stillOpening)
}

/**
 * Run again the restore last cut off by its time limit, unless a restore
 * has opened a project's queue since, checked when its turn comes (#52).
 * Like any restore, it does nothing once its project is no longer the one
 * being opened. The time-out notice goes once no restore is left cut off.
 */
export async function retryTimedOutRestore(): Promise<void> {
  const cutOff = timedOutRestore
  if (cutOff) {
    await restoreWhile(cutOff, () => timedOutRestore === cutOff && cutOff.stillOpening())
  }
  // The restore this retry waited behind may have been cut off too and
  // filed the notice again, for its own Retry (#52).
  if (!timedOutRestore) dismissRestoreTimeoutNotice()
}

/**
 * Dismiss the time-out notice once `projectId`'s merge queue is open, with
 * no pause or restore running. Project open calls it once it has loaded
 * the project's saved review items, which hold any notice filed before
 * the reopen, perhaps after its restore has opened the queue (#59).
 */
export function dismissStaleRestoreNotice(projectId: string): void {
  if (currentProjectId === projectId && !switchStepInFlight) {
    dismissRestoreTimeoutNotice()
  }
}

/** Restore a project's queue if `stillWanted` holds at its turn and after
 *  the open project is paused. */
async function restoreWhile(
  restore: QueueRestore,
  stillWanted: () => boolean,
): Promise<void> {
  try {
    await oneSwitchStepAtATime(async (abandoned) => {
      if (!stillWanted()) return
      await pauseActiveQueue()
      if (abandoned.aborted || !stillWanted()) return
      await loadProjectQueue(restore.projectId, restore.projectPath, abandoned)
      if (abandoned.aborted) return
      // Any notice the open review items show is stale once the queue is
      // open (#59). They are this project's without a project check: a
      // switch pauses the queue first (reset-project-state.ts), and that
      // pause waits behind this step (#62).
      timedOutRestore = null
      dismissRestoreTimeoutNotice()
    })
  } catch (err) {
    // The review queue open now is another project's once the user has
    // moved on, so that project's notice, if any, keeps its Retry (#52).
    if (err instanceof SwitchStepTimeoutError && restore.stillOpening()) {
      timedOutRestore = restore
      recordRestoreTimeout()
    }
    throw err
  }
}

/** Every time-out notice has this type and title, so one id. */
const RESTORE_TIMEOUT_NOTICE = {
  type: "confirm" as const,
  title: "Duplicate merge queue did not open",
}

/** The time-out notice's review id. */
export const RESTORE_TIMEOUT_NOTICE_ID = reviewIdFor(RESTORE_TIMEOUT_NOTICE)

/** Tell the user, in the review queue, that the merge queue did not open. */
function recordRestoreTimeout(): void {
  const item = {
    ...RESTORE_TIMEOUT_NOTICE,
    description: `Opening this project's duplicate merge queue took over ${SWITCH_STEP_TIMEOUT_MS / 1000} seconds and was stopped. Until it opens, no duplicate merge runs in this project. Retry to open it again; reopening the project also opens it.`,
    options: [{ label: "Retry", action: RETRY_RESTORE_ACTION }],
  }
  // A resolved notice from an earlier time-out would hide this one.
  dismissRestoreTimeoutNotice()
  useReviewStore.getState().addItem(item)
}

/** Dismiss the time-out notice if the review items hold one. With none, the
 *  items are left as they are: a change fires the review auto-save, which
 *  during project open could save the emptied items over the project's
 *  saved ones (#59). */
function dismissRestoreTimeoutNotice(): void {
  const { items, dismissItem } = useReviewStore.getState()
  if (items.some((item) => item.id === RESTORE_TIMEOUT_NOTICE_ID)) dismissItem(RESTORE_TIMEOUT_NOTICE_ID)
}

async function loadProjectQueue(
  projectId: string,
  projectPath: string,
  abandoned: AbortSignal,
): Promise<void> {
  const pp = normalizePath(projectPath)
  currentProjectId = projectId
  currentProjectPath = pp

  const saved = await loadQueue(pp, projectId)
  if (abandoned.aborted || saved.length === 0) return

  const mine = saved.filter((t) => t.projectId === projectId)
  if (mine.length !== saved.length) {
    console.warn(
      `[Dedup Queue] Dropped ${saved.length - mine.length} cross-project tasks during restore`,
    )
  }

  let restored = 0
  for (const task of mine) {
    if (task.status === "processing") {
      task.status = "pending"
      restored++
    }
  }

  queue = mine
  restoredPausedTaskIds = new Set(
    queue
      .filter((t) => t.status === "pending" && !t.scheduled)
      .map((t) => t.id),
  )
  await saveQueue(pp)
  if (abandoned.aborted) return

  const pending = queue.filter((t) => t.status === "pending").length
  const failed = queue.filter((t) => t.status === "failed").length
  if (pending > 0 || restored > 0) {
    console.log(
      `[Dedup Queue] Restored: ${pending} pending (${restoredPausedTaskIds.size} paused for manual resume), ${failed} failed, ${restored} reset from interrupted`,
    )
  }
  processNext(projectId)
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3
/** How often a merge held back by ingest checks whether ingest is idle. */
const INGEST_IDLE_CHECK_MS = 5_000

/** Check again once INGEST_IDLE_CHECK_MS has passed, with no click. */
function waitForIngestIdle(projectId: string): void {
  if (ingestWaitTimer) return
  ingestWaitTimer = setTimeout(() => {
    ingestWaitTimer = null
    processNext(projectId)
  }, INGEST_IDLE_CHECK_MS)
}

function stopIngestWait(): void {
  if (ingestWaitTimer) clearTimeout(ingestWaitTimer)
  ingestWaitTimer = null
}

/** Tell the user, in the review queue, that a merge was refused. */
function recordRejection(task: DedupTask, reason: string): void {
  useReviewStore.getState().addItem({
    type: "duplicate",
    title: `Duplicate merge rejected: ${task.group.slugs.join(", ")}`,
    description: `${reason}. Every page was left as it was and none was deleted. Retry the merge from the Maintenance screen, or merge the pages by hand.`,
    affectedPages: task.group.slugs.map((slug) => `${slug}.md`),
    options: [{ label: "Skip", action: "Skip" }],
  })
}

/** Re-embed the pages a merge wrote. An error is only logged: the merge
 *  itself is done or cancelled, and its outcome stands (#80, #82). */
async function reembedAfterMerge(pp: string, task: DedupTask, result: MergeResult): Promise<void> {
  try {
    await reembedMergedPages(pp, result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[Dedup Queue] Re-embed after merging ${task.group.slugs.join(",")} failed: ${message}`)
  }
}

async function processNext(projectId: string): Promise<void> {
  if (processing) return
  if (currentProjectId !== projectId) return

  const next = queue.find((t) =>
    t.projectId === projectId &&
    t.status === "pending" &&
    !restoredPausedTaskIds.has(t.id)
  )
  if (!next) return
  // A merge never starts while ingest is active (#24).
  if (isIngestActive()) {
    waitForIngestIdle(projectId)
    return
  }

  const registryPath = await getProjectPathById(projectId)
  const pp = registryPath ? normalizePath(registryPath) : ""
  // A cancel or another run may have moved the queue on during the lookup
  // (#35).
  if (
    currentProjectId !== projectId ||
    processing ||
    next.status !== "pending" ||
    !queue.includes(next)
  ) return

  if (!pp) {
    next.status = "failed"
    next.error = "Project not found in registry (was it deleted?)"
    notifyScheduledOutcome(next, "failed")
    await saveQueue(currentProjectPath)
    processNext(projectId)
    return
  }

  processing = true
  next.status = "processing"
  // The run owns this controller from here: a cancel or project switch
  // aborts it and takes over the queue state, so a run whose signal
  // fired touches none of it – the next merge may already be running
  // (#33).
  const controller = new AbortController()
  currentAbortController = controller
  const signal = controller.signal
  await saveQueue(pp)
  if (currentProjectId !== projectId || signal.aborted) return

  const llmConfig = getTaskLlmConfig("ingest")

  if (!hasUsableLlm(llmConfig)) {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    currentAbortController = null
    processing = false
    notifyScheduledOutcome(next, "failed")
    await saveQueue(pp)
    return
  }

  console.log(
    `[Dedup Queue] Processing: merge ${next.group.slugs.join(",")} → ${next.canonicalSlug}`,
  )

  try {
    // The merge holds the project write lock from its first read to its
    // last write, so an ingest that reaches its write meanwhile waits for
    // it. Ingest may have started during the waits above: re-check once
    // the lock is held, and hand the turn back if it has.
    const result = await withProjectLock(pp, async () => {
      if (isIngestActive()) return null
      return await executeMerge(pp, next.group, next.canonicalSlug, llmConfig, { signal })
    })
    const merged = result !== null
    // Tell the rest of the app the wiki tree changed, even if a cancel
    // landed while the merge wrote.
    if (merged && currentProjectId === projectId) useWikiStore.getState().bumpDataVersion()
    if (currentProjectId !== projectId || signal.aborted) {
      // A cancel or switch has taken the queue over; the pages the merge
      // wrote still get fresh vectors.
      if (merged) await reembedAfterMerge(pp, next, result)
      return
    }
    if (!merged) {
      currentAbortController = null
      next.status = "pending"
      processing = false
      await saveQueue(pp)
      // A switch during the save stopped this project's ingest wait (#48).
      if (currentProjectId === projectId) waitForIngestIdle(projectId)
      return
    }

    restoredPausedTaskIds.delete(next.id)
    queue = queue.filter((t) => t.id !== next.id)
    notifyScheduledOutcome(next, "done")
    await saveQueue(pp)

    console.log(`[Dedup Queue] Done: ${next.group.slugs.join(",")}`)
    // The task is done, so a cancel during the re-embed finds nothing to
    // cancel; the next merge waits for it. It runs after the lock is
    // released: a hung embedding endpoint must not hold an ingest's write
    // (#73). A failure here cannot fail the finished merge (#80).
    await reembedAfterMerge(pp, next, result)
  } catch (err) {
    if (currentProjectId !== projectId) return
    const message = err instanceof Error ? err.message : String(err)
    // Even a reply the page check refused files no review item once
    // cancelled.
    if (signal.aborted) {
      console.log(`[Dedup Queue] Cancelled: ${next.group.slugs.join(",")} — ${message}`)
      return
    }
    next.retryCount++
    next.error = message

    if (err instanceof MergeReplyRejectedError) {
      // Final: an automatic retry would re-spend the model on the same
      // group with no one watching. A retry by hand starts it again.
      next.status = "failed"
      recordRejection(next, message)
      notifyScheduledOutcome(next, "rejected")
      console.log(`[Dedup Queue] Rejected: ${next.group.slugs.join(",")} — ${message}`)
    } else if (next.retryCount >= MAX_RETRIES) {
      next.status = "failed"
      notifyScheduledOutcome(next, "failed")
      console.log(
        `[Dedup Queue] Failed (${next.retryCount}x): ${next.group.slugs.join(",")} — ${message}`,
      )
    } else {
      next.status = "pending"
      console.log(
        `[Dedup Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.group.slugs.join(",")} — ${message}`,
      )
    }
    await saveQueue(pp)
  }

  // A switch during the save above aborted this run and took the queue
  // over: the merge running now may be the next one's (#48).
  if (signal.aborted) return
  currentAbortController = null
  processing = false
  processNext(projectId)
}
