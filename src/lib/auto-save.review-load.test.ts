/**
 * The order of events behind #62: project open resumes auto-save before it
 * has read the project's saved review items. If the merge-queue restore
 * hits its time limit in that window, it files its notice into the empty
 * review items, and the review auto-save must not then write that notice
 * alone over the saved review file. Once the file loads, the store holds
 * both the saved items and the notice.
 *
 * Real auto-save, save and load code and merge-queue restore, over an
 * in-memory disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createDeferred } from "@/test-helpers/deferred"

vi.mock("./dedup-runner", () => ({ executeMerge: vi.fn() }))

const { files, heldReads } = vi.hoisted(() => ({
  files: new Map<string, string>(),
  /** A read of one of these paths waits on its promise. */
  heldReads: new Map<string, Promise<string>>(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const held = heldReads.get(path)
    if (held) return held
    const content = files.get(path)
    if (content === undefined) throw new Error(`no such file: ${path}`)
    return content
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    files.set(path, content)
  }),
  createDirectory: vi.fn(async () => {}),
  listDirectory: vi.fn(async () => []),
}))

vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async () => null),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import { setupAutoSave, runWithSuspendedAutoSave, loadSavedReviewItems } from "./auto-save"
import { restoreQueue, clearQueueState, SwitchStepTimeoutError, SWITCH_STEP_TIMEOUT_MS } from "./dedup-queue"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

const PROJECT = { id: "project-b-id", name: "B", path: "/project-b" }
const REVIEW_FILE = `${PROJECT.path}/.llm-wiki/review.json`
const QUEUE_FILE = `${PROJECT.path}/.llm-wiki/dedup-queue.json`
const NOTICE_TITLE = "Duplicate merge queue did not open"

const SAVED: ReviewItem[] = [
  { id: "review-saved", type: "missing-page", title: "Saved review", description: "", options: [], resolved: false, createdAt: 1 },
]
const SAVED_FILE = JSON.stringify(SAVED, null, 2)

function isOpen(): boolean {
  return useWikiStore.getState().project?.id === PROJECT.id
}

/** Project open as `handleProjectOpened` runs it: the stores are emptied
 *  and the project set while auto-save is suspended, then auto-save
 *  resumes before the saved review items are read. */
async function openProject(): Promise<void> {
  await runWithSuspendedAutoSave(async () => {
    useReviewStore.setState({ items: [] })
    useWikiStore.setState({ project: PROJECT as never })
  })
}

let registered = false

beforeEach(() => {
  vi.useFakeTimers()
  files.clear()
  heldReads.clear()
  files.set(REVIEW_FILE, SAVED_FILE)
  clearQueueState()
  useReviewStore.setState({ items: [] })
  useWikiStore.setState({ project: null })
  // setupAutoSave registers permanent subscriptions; only do it once.
  if (!registered) {
    setupAutoSave()
    registered = true
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe("a restore time-out notice filed before the saved review items load (#62)", () => {
  it("is not saved over the saved review file, and is kept beside the saved items once they load", async () => {
    const reviewRead = createDeferred<string>()
    heldReads.set(REVIEW_FILE, reviewRead.promise)
    heldReads.set(QUEUE_FILE, new Promise(() => {}))

    await openProject()
    const loaded = loadSavedReviewItems(PROJECT.path, isOpen)
    const restore = restoreQueue(PROJECT.id, PROJECT.path, isOpen).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)
    expect(await restore).toBeInstanceOf(SwitchStepTimeoutError)
    expect(useReviewStore.getState().items.map((i) => i.title)).toEqual([NOTICE_TITLE])

    // Well past the review auto-save's debounce, the file is still unread.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(files.get(REVIEW_FILE)).toBe(SAVED_FILE)

    reviewRead.resolve(SAVED_FILE)
    expect(await loaded).toBe(true)
    expect(useReviewStore.getState().items.map((i) => i.title)).toEqual(["Saved review", NOTICE_TITLE])

    await vi.advanceTimersByTimeAsync(1_000)
    const written = JSON.parse(files.get(REVIEW_FILE)!) as ReviewItem[]
    expect(written.map((i) => i.title)).toEqual(["Saved review", NOTICE_TITLE])
  })

  it("is not flushed over the saved review file when the user leaves the project before it loads", async () => {
    heldReads.set(REVIEW_FILE, new Promise(() => {}))
    heldReads.set(QUEUE_FILE, new Promise(() => {}))

    await openProject()
    void loadSavedReviewItems(PROJECT.path, isOpen)
    const restore = restoreQueue(PROJECT.id, PROJECT.path, isOpen).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)
    expect(await restore).toBeInstanceOf(SwitchStepTimeoutError)

    // The next project open flushes the open project's stores first.
    await runWithSuspendedAutoSave(async () => {
      useReviewStore.setState({ items: [] })
      useWikiStore.setState({ project: null })
    })

    expect(files.get(REVIEW_FILE)).toBe(SAVED_FILE)
  })

  it("is not saved over the saved review file when the project is reopened while its first load is still reading", async () => {
    const firstRead = createDeferred<string>()
    heldReads.set(REVIEW_FILE, firstRead.promise)
    heldReads.set(QUEUE_FILE, new Promise(() => {}))

    await openProject()
    const firstLoad = loadSavedReviewItems(PROJECT.path, isOpen)
    // The user reopens the same project; its first load lands mid-switch.
    heldReads.set(REVIEW_FILE, new Promise(() => {}))
    await runWithSuspendedAutoSave(async () => {
      firstRead.resolve(SAVED_FILE)
      expect(await firstLoad).toBe(false)
      useReviewStore.setState({ items: [] })
      useWikiStore.setState({ project: PROJECT as never })
    })
    void loadSavedReviewItems(PROJECT.path, isOpen)
    const restore = restoreQueue(PROJECT.id, PROJECT.path, isOpen).catch((err: unknown) => err)
    await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)
    expect(await restore).toBeInstanceOf(SwitchStepTimeoutError)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(files.get(REVIEW_FILE)).toBe(SAVED_FILE)
  })
})
