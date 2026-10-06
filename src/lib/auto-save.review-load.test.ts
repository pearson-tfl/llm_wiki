/**
 * The order of events behind #62: project open resumes auto-save before it
 * has read the project's saved review items. If the merge-queue restore
 * hits its time limit in that window, it files its notice into the empty
 * review items, and the review auto-save must not then write that notice
 * alone over the saved review file. Once the file loads, the store holds
 * both the saved items and the notice.
 *
 * Real auto-save, save and load code and merge-queue restore, on a real
 * temp folder; only the clock is fake, and chosen reads are held.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createDeferred, flushIO } from "@/test-helpers/deferred"
import { createTempProject, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("./dedup-runner", () => ({ executeMerge: vi.fn(), reembedMergedPages: vi.fn() }))

const { heldReads } = vi.hoisted(() => ({
  /** A read of one of these paths waits on its promise. */
  heldReads: new Map<string, Promise<string>>(),
}))

vi.mock("@/commands/fs", async () => {
  const { realFs } = await import("@/test-helpers/fs-temp")
  return {
    ...realFs,
    readFile: async (path: string) => heldReads.get(path) ?? realFs.readFile(path),
  }
})

vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async () => null),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import { setupAutoSave, runWithSuspendedAutoSave, loadSavedReviewItems, loadReviewItemsOnOpen } from "./auto-save"
import {
  restoreQueue,
  clearQueueState,
  SwitchStepTimeoutError,
  SWITCH_STEP_TIMEOUT_MS,
  RESTORE_TIMEOUT_NOTICE_ID,
} from "./dedup-queue"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

const NOTICE_TITLE = "Duplicate merge queue did not open"

const SAVED: ReviewItem[] = [
  { id: "review-saved", type: "missing-page", title: "Saved review", description: "", options: [], resolved: false, createdAt: 1 },
]
const SAVED_FILE = JSON.stringify(SAVED, null, 2)

let tmp: { path: string; cleanup: () => Promise<void> }
let project: { id: string; name: string; path: string }
let reviewFile = ""
let queueFile = ""

function isOpen(): boolean {
  return useWikiStore.getState().project?.id === project.id
}

/** Project open as `handleProjectOpened` runs it: the stores are emptied
 *  and the project set while auto-save is suspended, then auto-save
 *  resumes before the saved review items are read. */
async function openProject(): Promise<void> {
  await runWithSuspendedAutoSave(async () => {
    useReviewStore.setState({ items: [] })
    useWikiStore.setState({ project: project as never })
  })
}

/** Let any review save the fake clock has set off reach the disk. */
async function settleWrites(): Promise<void> {
  await flushIO(50)
}

/** Read the review file once a save has replaced `before`, or throw. A
 *  read mid-save sees the file truncated, so empty does not count. */
async function reviewFileAfterSave(before: string): Promise<string> {
  for (let tick = 0; tick < 1_000; tick++) {
    const content = await readFileRaw(reviewFile)
    if (content !== "" && content !== before) return content
    await flushIO(1)
  }
  throw new Error("the review file was never saved")
}

let registered = false

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  heldReads.clear()
  tmp = await createTempProject("review-load")
  project = { id: "project-b-id", name: "B", path: tmp.path }
  reviewFile = `${tmp.path}/.llm-wiki/review.json`
  queueFile = `${tmp.path}/.llm-wiki/dedup-queue.json`
  await writeFileRaw(reviewFile, SAVED_FILE)
  clearQueueState()
  useReviewStore.setState({ items: [] })
  useWikiStore.setState({ project: null })
  // setupAutoSave registers permanent subscriptions; only do it once.
  if (!registered) {
    setupAutoSave()
    registered = true
  }
})

afterEach(async () => {
  vi.useRealTimers()
  await tmp.cleanup()
})

describe("a restore time-out notice filed before the saved review items load (#62)", () => {
  it("is not saved over the saved review file, and is kept beside the saved items once they load", async () => {
    const reviewRead = createDeferred<string>()
    heldReads.set(reviewFile, reviewRead.promise)
    heldReads.set(queueFile, new Promise(() => {}))

    await openProject()
    const loaded = loadSavedReviewItems(project.path, isOpen)
    const restore = restoreQueue(project.id, project.path, isOpen).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)
    expect(await restore).toBeInstanceOf(SwitchStepTimeoutError)
    expect(useReviewStore.getState().items.map((i) => i.title)).toEqual([NOTICE_TITLE])

    // Well past the review auto-save's debounce, the file is still unread.
    await vi.advanceTimersByTimeAsync(5_000)
    await settleWrites()
    expect(await readFileRaw(reviewFile)).toBe(SAVED_FILE)

    reviewRead.resolve(SAVED_FILE)
    expect(await loaded).toBe(true)
    expect(useReviewStore.getState().items.map((i) => i.title)).toEqual(["Saved review", NOTICE_TITLE])

    await vi.advanceTimersByTimeAsync(1_000)
    const written = JSON.parse(await reviewFileAfterSave(SAVED_FILE)) as ReviewItem[]
    expect(written.map((i) => i.title)).toEqual(["Saved review", NOTICE_TITLE])
  })

  it("is not flushed over the saved review file when the user leaves the project before it loads", async () => {
    heldReads.set(reviewFile, new Promise(() => {}))
    heldReads.set(queueFile, new Promise(() => {}))

    await openProject()
    void loadSavedReviewItems(project.path, isOpen)
    const restore = restoreQueue(project.id, project.path, isOpen).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)
    expect(await restore).toBeInstanceOf(SwitchStepTimeoutError)

    // The next project open flushes the open project's stores first.
    await runWithSuspendedAutoSave(async () => {
      useReviewStore.setState({ items: [] })
      useWikiStore.setState({ project: null })
    })

    await settleWrites()
    expect(await readFileRaw(reviewFile)).toBe(SAVED_FILE)
  })

  it("is not saved over the saved review file when the project is reopened while its first load is still reading", async () => {
    const firstRead = createDeferred<string>()
    heldReads.set(reviewFile, firstRead.promise)
    heldReads.set(queueFile, new Promise(() => {}))

    await openProject()
    const firstLoad = loadSavedReviewItems(project.path, isOpen)
    // The user reopens the same project; its first load lands mid-switch.
    heldReads.set(reviewFile, new Promise(() => {}))
    await runWithSuspendedAutoSave(async () => {
      firstRead.resolve(SAVED_FILE)
      expect(await firstLoad).toBe(false)
      useReviewStore.setState({ items: [] })
      useWikiStore.setState({ project: project as never })
    })
    void loadSavedReviewItems(project.path, isOpen)
    const restore = restoreQueue(project.id, project.path, isOpen).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)
    expect(await restore).toBeInstanceOf(SwitchStepTimeoutError)
    await vi.advanceTimersByTimeAsync(5_000)
    await settleWrites()

    expect(await readFileRaw(reviewFile)).toBe(SAVED_FILE)
  })
})

describe("an item that arrives while the saved review items load (#65)", () => {
  it("leaves the saved item resolved when the same item arrives unresolved", async () => {
    const savedFile = JSON.stringify([{ ...SAVED[0], resolved: true, resolvedAction: "skip" }], null, 2)
    await writeFileRaw(reviewFile, savedFile)
    const reviewRead = createDeferred<string>()
    heldReads.set(reviewFile, reviewRead.promise)

    await openProject()
    const loaded = loadSavedReviewItems(project.path, isOpen, RESTORE_TIMEOUT_NOTICE_ID)
    const { type, title, description, options } = SAVED[0]
    useReviewStore.getState().addItem({ type, title, description, options })
    reviewRead.resolve(savedFile)

    expect(await loaded).toBe(true)
    expect(useReviewStore.getState().items).toEqual([
      expect.objectContaining({ title: "Saved review", resolved: true, resolvedAction: "skip" }),
    ])
  })

  it("re-opens a saved resolved time-out notice when the restore times out again", async () => {
    const savedNotice: ReviewItem = {
      id: RESTORE_TIMEOUT_NOTICE_ID, type: "confirm", title: NOTICE_TITLE, description: "",
      options: [], resolved: true, resolvedAction: "skip", createdAt: 1,
    }
    const savedFile = JSON.stringify([savedNotice], null, 2)
    await writeFileRaw(reviewFile, savedFile)
    const reviewRead = createDeferred<string>()
    heldReads.set(reviewFile, reviewRead.promise)
    heldReads.set(queueFile, new Promise(() => {}))

    await openProject()
    const loaded = loadSavedReviewItems(project.path, isOpen, RESTORE_TIMEOUT_NOTICE_ID)
    const restore = restoreQueue(project.id, project.path, isOpen).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)
    expect(await restore).toBeInstanceOf(SwitchStepTimeoutError)
    reviewRead.resolve(savedFile)

    expect(await loaded).toBe(true)
    expect(useReviewStore.getState().items).toEqual([
      expect.objectContaining({ title: NOTICE_TITLE, resolved: false }),
    ])
  })

  it("leaves a saved time-out notice in place when no notice arrives", async () => {
    const savedNotice: ReviewItem = {
      id: RESTORE_TIMEOUT_NOTICE_ID, type: "confirm", title: NOTICE_TITLE, description: "",
      options: [], resolved: false, createdAt: 1,
    }
    const savedFile = JSON.stringify([savedNotice], null, 2)
    await writeFileRaw(reviewFile, savedFile)
    const reviewRead = createDeferred<string>()
    heldReads.set(reviewFile, reviewRead.promise)

    await openProject()
    const loaded = loadSavedReviewItems(project.path, isOpen, RESTORE_TIMEOUT_NOTICE_ID)
    const { type, title, description, options } = SAVED[0]
    useReviewStore.getState().addItem({ type, title, description, options })
    reviewRead.resolve(savedFile)

    expect(await loaded).toBe(true)
    expect(useReviewStore.getState().items.map((i) => i.title)).toEqual([NOTICE_TITLE, "Saved review"])
  })

  it("is saved to an empty saved review file with no further change", async () => {
    await writeFileRaw(reviewFile, "[]")
    const reviewRead = createDeferred<string>()
    heldReads.set(reviewFile, reviewRead.promise)

    await openProject()
    const loaded = loadSavedReviewItems(project.path, isOpen, RESTORE_TIMEOUT_NOTICE_ID)
    const { type, title, description, options } = SAVED[0]
    useReviewStore.getState().addItem({ type, title, description, options })
    reviewRead.resolve("[]")
    expect(await loaded).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    const written = JSON.parse(await reviewFileAfterSave("[]")) as ReviewItem[]
    expect(written.map((i) => i.title)).toEqual(["Saved review"])
  })
})

describe("project open's review load (#65)", () => {
  it("dismisses a saved time-out notice once the merge queue has opened", async () => {
    const savedNotice: ReviewItem = {
      id: RESTORE_TIMEOUT_NOTICE_ID, type: "confirm", title: NOTICE_TITLE, description: "",
      options: [], resolved: false, createdAt: 1,
    }
    await writeFileRaw(reviewFile, JSON.stringify([...SAVED, savedNotice], null, 2))

    await openProject()
    await restoreQueue(project.id, project.path, isOpen)
    await loadReviewItemsOnOpen(project.id, project.path, isOpen)

    expect(useReviewStore.getState().items.map((i) => i.title)).toEqual(["Saved review"])
  })
})
