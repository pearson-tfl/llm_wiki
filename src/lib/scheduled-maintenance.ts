/**
 * Scheduled maintenance job (#16 fixes 2 and 3, tickets #18 and #19): a
 * per-project timer that runs the vector backfill (#67), the existing
 * duplicate scan, then any hub-rebuild request, with no click. Started and stopped the same way as
 * scheduled import, for the open project only.
 */
import { fileExists, listDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  loadScheduledMaintenanceConfig,
  saveScheduledMaintenanceConfig,
  type ScheduledMaintenanceConfig,
} from "@/lib/project-store"
import { runDuplicateDetection, type FailedDetectorBatch, type ScanNotDone } from "@/lib/dedup-runner"
import { sweepResolvedReviews } from "@/lib/sweep-reviews"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { useWikiStore } from "@/stores/wiki-store"
import { isIngestActive } from "@/lib/ingest-queue"
import { enqueueMerge, getQueue, waitForTask, type DedupTaskOutcome } from "@/lib/dedup-queue"
import {
  holdsNotDuplicate,
  readNotDuplicates,
  savePendingDuplicateGroups,
} from "@/lib/dedup-storage"
import { parseFrontmatter } from "@/lib/frontmatter"
import { runHubRebuildRequest } from "@/lib/hub-rebuild"
import { runEmbeddingBackfill, type VectorCoverage } from "@/lib/embedding-freshness"
import { parseSources } from "@/lib/sources-merge"
import type { DuplicateGroup } from "@/lib/dedup"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode, WikiProject } from "@/types/wiki"

const RUN_RECORD_PATH = ".llm-wiki/maintenance-runs.jsonl"

export type MaintenanceSkipReason =
  | "ingest-busy"
  | "previous-tick-running"
  | "no-model"
  | "switched-off"

/** How often the timer checks whether the job is due. The interval in
 *  the setting is hours; this only bounds how late a due run starts. */
const CHECK_INTERVAL_MS = 10 * 60 * 1000

let tickRunning = false
let checkTimer: ReturnType<typeof setInterval> | null = null
/** Run-record appends, one at a time, so a skip written while a run is
 *  finishing cannot overwrite the run's own record. */
let recordWrites: Promise<unknown> = Promise.resolve()

export interface MaintenanceRunRecord {
  startedAt: string
  finishedAt: string
  skipReason: MaintenanceSkipReason | null
  groupsFound?: { high: number; medium: number; low: number }
  mergesEnqueued?: number
  mergesDone?: number
  /** Merges that failed every retry; rejected, cancelled or interrupted
   *  ones are not counted here. */
  mergesFailed?: number
  /** Present when a hub-rebuild request was processed. */
  hubsRebuilt?: string[]
  hubsRejected?: string[]
  /** Merges whose model reply failed the check before any write, so no
   *  page changed (#24). */
  mergesRejected?: number
  rejectedMerges?: { slugs: string[]; reason: string }[]
  /** Detector calls whose reply could not be read, so their pages went
   *  unchecked (#108); absent when every call was read. */
  failedDetectorBatches?: FailedDetectorBatch[]
  /** Why the model checked none of a large wiki's pages (#112); absent
   *  when it ran. */
  duplicateScanNotDone?: ScanNotDone
  /** The vector backfill's counts (#67); absent while embeddings are off. */
  vectorCoverage?: VectorCoverage
  error?: string
}

export function isMaintenanceDue(config: ScheduledMaintenanceConfig, now: number): boolean {
  if (!config.enabled || config.intervalHours <= 0) return false
  if (config.lastRun === null) return true
  return now - config.lastRun >= config.intervalHours * 60 * 60 * 1000
}

/**
 * One tick of the job. Returns null when the job is not due by `now`;
 * otherwise the run record it appended.
 */
export async function runMaintenanceTick(
  project: WikiProject,
  clock: { now: () => number },
): Promise<MaintenanceRunRecord | null> {
  const pp = normalizePath(project.path)
  const config = await loadScheduledMaintenanceConfig(pp)
  const startedAt = clock.now()
  if (!isMaintenanceDue(config, startedAt)) return null

  const llmConfig = getTaskLlmConfig("ingest")
  // No await between this check and setting the flag, so two ticks can
  // never both pass it.
  const skipReason = startBlocker(llmConfig)
  if (skipReason) {
    // A skip is not a run: lastRun stays put, so the job stays due.
    return appendRunRecord(pp, {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(clock.now()).toISOString(),
      skipReason,
    })
  }

  tickRunning = true
  const record: MaintenanceRunRecord = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: "",
    skipReason: null,
  }
  let groups: DuplicateGroup[] = []
  const enqueued: DuplicateGroup[] = []
  const taskIds: string[] = []
  const outcomes: Promise<DedupTaskOutcome>[] = []
  try {
    // The backfill first, so the hub rebuild's search sees every page.
    try {
      const coverage = await runEmbeddingBackfill(pp, useWikiStore.getState().embeddingConfig)
      if (coverage) record.vectorCoverage = coverage
    } catch (err) {
      record.error = `vector backfill: ${err instanceof Error ? err.message : String(err)}`
    }

    try {
      const scan = await runDuplicateDetection(pp, llmConfig)
      groups = scan.groups
      if (scan.failedBatches.length > 0) record.failedDetectorBatches = scan.failedBatches
      if (scan.notDone) record.duplicateScanNotDone = scan.notDone
      record.groupsFound = {
        high: groups.filter((g) => g.confidence === "high").length,
        medium: groups.filter((g) => g.confidence === "medium").length,
        low: groups.filter((g) => g.confidence === "low").length,
      }
      const notDuplicates = await readNotDuplicates(pp)
      // Only high-confidence groups merge with no click. A group holding a
      // pair marked "not duplicates" is left for a decision by hand.
      const toMerge = groups.filter(
        (g) => g.confidence === "high" && !holdsNotDuplicate(g.slugs, notDuplicates),
      )
      for (const group of toMerge) {
        // The scan took a while: re-read what gates a merge before each one.
        const withheld = await mergeBlocker(pp)
        if (withheld) {
          record.skipReason = withheld
          break
        }
        const canonical = await chooseCanonicalSlug(pp, group)
        const taskId = await enqueueMerge(project.id, group, canonical, { scheduled: true })
        enqueued.push(group)
        taskIds.push(taskId)
        outcomes.push(waitForTask(taskId))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      record.error = record.error ? `${record.error}; ${message}` : message
    }

    if (record.groupsFound) {
      // Every group not queued for a merge, withheld ones included, is kept
      // for the Maintenance screen.
      await savePendingDuplicateGroups(pp, groups.filter((g) => !enqueued.includes(g)))
      record.mergesEnqueued = outcomes.length
      const settled = await Promise.all(outcomes)
      record.mergesDone = settled.filter((o) => o === "done").length
      record.mergesFailed = settled.filter((o) => o === "failed").length
      record.mergesRejected = settled.filter((o) => o === "rejected").length
      if (record.mergesRejected > 0) {
        // A rejected task stays on the queue, failed, with the reason.
        record.rejectedMerges = taskIds.flatMap((id, i) =>
          settled[i] === "rejected"
            ? [{ slugs: enqueued[i].slugs, reason: getQueue().find((t) => t.id === id)?.error ?? "" }]
            : [],
        )
      }
      // Close review items whose pages the merges removed.
      if (record.mergesDone > 0) await sweepResolvedReviews(pp)
    }

    // Hub rebuild, after the duplicate scan, unless the scan's merges
    // were withheld: whatever withheld them still holds.
    if (record.skipReason === null) {
      try {
        const hubs = await runHubRebuildRequest(
          pp,
          llmConfig,
          new Date(startedAt).toISOString().slice(0, 10),
          () => mergeBlocker(pp),
        )
        if (hubs) {
          record.hubsRebuilt = hubs.rebuilt
          record.hubsRejected = hubs.rejected
          record.skipReason = hubs.withheld
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        record.error = record.error ? `${record.error}; ${message}` : message
      }
    }
  } catch (err) {
    record.error ??= err instanceof Error ? err.message : String(err)
  } finally {
    tickRunning = false
  }

  // A run whose merges were withheld stays due, like a skip. A run that
  // failed still counts as a run, so a broken model does not re-spend the
  // scan at every check. Re-read the setting: it may have been edited
  // while the run was going.
  if (record.skipReason === null) {
    const current = await loadScheduledMaintenanceConfig(pp)
    await saveScheduledMaintenanceConfig(pp, { ...current, lastRun: startedAt })
  }
  record.finishedAt = new Date(clock.now()).toISOString()
  return appendRunRecord(pp, record)
}

function startBlocker(llmConfig: LlmConfig): MaintenanceSkipReason | null {
  if (tickRunning) return "previous-tick-running"
  if (isIngestActive()) return "ingest-busy"
  if (!hasUsableLlm(llmConfig)) return "no-model"
  return null
}

async function mergeBlocker(pp: string): Promise<MaintenanceSkipReason | null> {
  if (!(await loadScheduledMaintenanceConfig(pp)).enabled) return "switched-off"
  return isIngestActive() ? "ingest-busy" : null
}

/** Start the job for the opened project: an overdue run starts now. */
export function startScheduledMaintenance(project: WikiProject): void {
  stopScheduledMaintenance()
  const check = () => {
    if (useWikiStore.getState().project?.id !== project.id) return
    void runMaintenanceTick(project, { now: Date.now }).catch((err) => {
      console.error("Scheduled maintenance tick failed:", err)
    })
  }
  check()
  checkTimer = setInterval(check, CHECK_INTERVAL_MS)
}

export function stopScheduledMaintenance(): void {
  if (checkTimer) {
    clearInterval(checkTimer)
    checkTimer = null
  }
}

function appendRunRecord(
  pp: string,
  record: MaintenanceRunRecord,
): Promise<MaintenanceRunRecord> {
  const path = `${pp}/${RUN_RECORD_PATH}`
  const write = recordWrites.then(async () => {
    // A file that exists but cannot be read fails the append rather than
    // being rewritten from empty.
    const existing = (await fileExists(path)) ? await readFile(path) : ""
    await writeFile(path, `${existing}${JSON.stringify(record)}\n`)
    return record
  })
  recordWrites = write.catch(() => undefined)
  return write
}

/**
 * The page a group merges into: most sources, then earliest created date,
 * then first in the group. Slugs resolve to pages by basename anywhere
 * under wiki/.
 */
async function chooseCanonicalSlug(pp: string, group: DuplicateGroup): Promise<string> {
  const paths = new Map<string, string>()
  for (const file of walkFiles(await listDirectory(`${pp}/wiki`))) {
    if (file.name.endsWith(".md")) paths.set(file.name.slice(0, -3), file.path)
  }
  const ranked = await Promise.all(
    group.slugs.map(async (slug, position) => {
      const path = paths.get(slug)
      const content = path ? await readFile(path).catch(() => "") : ""
      const created = Date.parse(String(parseFrontmatter(content).frontmatter?.created ?? ""))
      return {
        slug,
        position,
        sources: parseSources(content).length,
        created: Number.isNaN(created) ? Infinity : created,
      }
    }),
  )
  ranked.sort((a, b) =>
    b.sources - a.sources || a.created - b.created || a.position - b.position,
  )
  return ranked[0].slug
}

function* walkFiles(nodes: FileNode[]): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) yield* walkFiles(node.children ?? [])
    else yield node
  }
}
