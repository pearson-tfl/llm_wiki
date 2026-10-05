import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createDeferred, flushMicrotasks, type Deferred } from "@/test-helpers/deferred"

vi.mock("./dedup-runner", () => ({
  executeMerge: vi.fn(),
}))

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

const TEST_ID = "test-project-uuid"
const TEST_PATH = "/project"
const TEST_ID_B = "test-project-uuid-b"
const TEST_PATH_B = "/project-b"
const idToPath: Record<string, string> = {
  [TEST_ID]: TEST_PATH,
  [TEST_ID_B]: TEST_PATH_B,
}
/** While set, every registry lookup waits for it. */
let registryHold: Promise<void> | null = null
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => {
    if (registryHold) await registryHold
    return idToPath[id] ?? null
  }),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import {
  enqueueMerge,
  cancelTask,
  retryTask,
  clearQueueState,
  getQueue,
  getQueueSummary,
  pauseQueue,
  restoreQueue,
  resumeProcessing,
  waitForTask,
  SWITCH_STEP_TIMEOUT_MS,
  SwitchStepTimeoutError,
} from "./dedup-queue"
import { executeMerge } from "./dedup-runner"
import { readFile, writeFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { __resetProjectLocksForTesting } from "./project-mutex"
import { MergeReplyRejectedError, type DuplicateGroup, type MergeResult } from "./dedup"

const mockExecuteMerge = vi.mocked(executeMerge)
const mockReadFile = vi.mocked(readFile)
const mockWriteFile = vi.mocked(writeFile)

const EMPTY_MERGE: MergeResult = {
  canonicalContent: "",
  canonicalPath: "",
  rewrites: [],
  pagesToDelete: [],
  backup: [],
}

function makeGroup(slugs: string[]): DuplicateGroup {
  return { slugs, confidence: "high", reason: "test" }
}

async function activate(id: string = TEST_ID): Promise<void> {
  await restoreQueue(id, idToPath[id])
}

beforeEach(async () => {
  clearQueueState()
  registryHold = null
  // A merge a test left hanging still holds the project write lock.
  __resetProjectLocksForTesting()
  mockExecuteMerge.mockReset()
  mockReadFile.mockReset()
  mockWriteFile.mockReset()
  mockReadFile.mockRejectedValue(new Error("ENOENT"))
  mockWriteFile.mockResolvedValue(undefined as unknown as void)

  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })

  await activate()
})

describe("dedup-queue — basic enqueue + processing", () => {
  it("processes a queued merge and removes the task on success", async () => {
    mockExecuteMerge.mockResolvedValue({
      canonicalContent: "x",
      canonicalPath: "wiki/entities/a.md",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    const id = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    expect(id).toMatch(/^dedup-/)

    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
  })

  it("persists pending queue to disk", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(2)

    expect(mockWriteFile).toHaveBeenCalled()
    const call = mockWriteFile.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("dedup-queue.json"),
    )
    expect(call).toBeTruthy()
  })

  it("dedupes on slug-set: re-enqueueing the same group returns the same id", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
    const id1 = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    const id2 = await enqueueMerge(TEST_ID, makeGroup(["b", "a"]), "b")
    expect(id2).toBe(id1)
    expect(getQueue()).toHaveLength(1)
  })

  it("processes serially: second task only starts after first completes", async () => {
    const d1 = createDeferred<void>()
    const d2 = createDeferred<void>()
    let calls = 0
    mockExecuteMerge.mockImplementation(async () => {
      calls++
      const which = calls
      await (which === 1 ? d1.promise : d2.promise)
      return {
        canonicalContent: "",
        canonicalPath: "",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      }
    })

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c")
    await flushMicrotasks(5)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(1)

    d1.resolve()
    await flushMicrotasks(20)
    expect(mockExecuteMerge).toHaveBeenCalledTimes(2)

    d2.resolve()
    await flushMicrotasks(20)
    expect(getQueue()).toHaveLength(0)
  })
})

describe("dedup-queue — retries", () => {
  it("retries on failure up to MAX_RETRIES (3) before marking failed", async () => {
    mockExecuteMerge.mockRejectedValue(new Error("LLM boom"))

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(40)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(3)
    const tasks = getQueue()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].status).toBe("failed")
    expect(tasks[0].retryCount).toBe(3)
    expect(tasks[0].error).toContain("LLM boom")
  })

  it("succeeds after a transient failure within retry budget", async () => {
    mockExecuteMerge
      .mockRejectedValueOnce(new Error("flaky"))
      .mockRejectedValueOnce(new Error("flaky"))
      .mockResolvedValueOnce({
        canonicalContent: "",
        canonicalPath: "",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      })

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(40)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(3)
    expect(getQueue()).toHaveLength(0)
  })

  it("retryTask resets a failed task to pending and runs it again", async () => {
    mockExecuteMerge.mockRejectedValue(new Error("boom"))

    const id = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(40)
    expect(getQueue()[0].status).toBe("failed")
    expect(mockExecuteMerge).toHaveBeenCalledTimes(3)

    mockExecuteMerge.mockResolvedValueOnce({
      canonicalContent: "",
      canonicalPath: "",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    await retryTask(id)
    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(4)
    expect(getQueue()).toHaveLength(0)
  })
})

describe("dedup-queue — cancel / delete", () => {
  it("cancelTask removes a pending task before it runs", async () => {
    const d = createDeferred<void>()
    mockExecuteMerge.mockImplementation(async () => {
      await d.promise
      return {
        canonicalContent: "",
        canonicalPath: "",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      }
    })

    const firstId = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    const secondId = await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c")
    await flushMicrotasks(5)

    // First is processing, second is pending — cancel the pending one.
    expect(getQueue().find((t) => t.id === secondId)?.status).toBe("pending")
    await cancelTask(secondId)
    expect(getQueue().find((t) => t.id === secondId)).toBeUndefined()

    d.resolve()
    await flushMicrotasks(10)
    expect(getQueue().find((t) => t.id === firstId)).toBeUndefined()
    void firstId
  })

  it("cancelTask aborts an in-flight processing task", async () => {
    let receivedSignal: AbortSignal | undefined
    const d = createDeferred<never>()
    mockExecuteMerge.mockImplementation(async (_pp, _g, _slug, _llm, opts) => {
      receivedSignal = opts?.signal
      // Reject when aborted
      opts?.signal?.addEventListener("abort", () => {
        d.reject(new Error("aborted"))
      })
      return d.promise
    })

    const id = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(5)
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal?.aborted).toBe(false)

    await cancelTask(id)
    expect(receivedSignal?.aborted).toBe(true)
    expect(getQueue().find((t) => t.id === id)).toBeUndefined()
  })

  // #33: the cancelled merge's run ends only after the next has started.
  it.each([
    // The last column: data-version bumps, since pages a cancelled merge
    // finished writing still reach the wiki tree.
    ["fails", (d: Deferred<MergeResult>) => d.reject(new Error("Duplicate merge cancelled before the model's reply finished")), 0],
    ["finishes its writes", (d: Deferred<MergeResult>) => d.resolve(EMPTY_MERGE), 1],
  ])("after a cancelled merge %s late, the next can be cancelled and no third starts while it runs", async (_label, endCancelledRun, bumps) => {
    const signals: AbortSignal[] = []
    const runs: Deferred<MergeResult>[] = []
    mockExecuteMerge.mockImplementation(async (_pp, _g, _slug, _llm, opts) => {
      signals.push(opts!.signal!)
      const d = createDeferred<MergeResult>()
      runs.push(d)
      return d.promise
    })
    const versionBefore = useWikiStore.getState().dataVersion

    const first = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    const second = await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c")
    const third = await enqueueMerge(TEST_ID, makeGroup(["e", "f"]), "e")
    await flushMicrotasks(5)

    // The next merge starts at once, and waits for the project lock the
    // cancelled one still holds.
    await cancelTask(first)
    await flushMicrotasks(20)
    expect(getQueue().find((t) => t.id === second)?.status).toBe("processing")

    endCancelledRun(runs[0])
    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(2)
    expect(getQueue().map((t) => [t.id, t.status])).toEqual([
      [second, "processing"],
      [third, "pending"],
    ])
    expect(useWikiStore.getState().dataVersion).toBe(versionBefore + bumps)

    await cancelTask(second)
    expect(signals[1].aborted).toBe(true)
    runs[1].reject(new Error("Duplicate merge cancelled before the model's reply finished"))
    await flushMicrotasks(20)
    expect(mockExecuteMerge).toHaveBeenCalledTimes(3)
    expect(mockExecuteMerge.mock.calls[2][1].slugs).toEqual(["e", "f"])
  })

  it("a merge cancelled while it saves its processing state never runs (#33)", async () => {
    mockExecuteMerge.mockResolvedValue(EMPTY_MERGE)
    const save = createDeferred<void>()
    let held = false
    mockWriteFile.mockImplementation(async (_path, content) => {
      if (!held && content.includes('"processing"')) {
        held = true
        await save.promise
      }
    })

    const first = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c")
    await flushMicrotasks(5)
    expect(held).toBe(true)

    await cancelTask(first)
    await flushMicrotasks(20)
    save.resolve()
    await flushMicrotasks(20)

    expect(mockExecuteMerge.mock.calls.map((c) => c[1].slugs)).toEqual([["c", "d"]])
  })

  it("a merge cancelled while the queue looks up its project never runs, and the next stays cancellable (#35)", async () => {
    const signals: AbortSignal[] = []
    mockExecuteMerge.mockImplementation(async (_pp, _g, _slug, _llm, opts) => {
      signals.push(opts!.signal!)
      return new Promise<MergeResult>(() => {})
    })
    const lookup = createDeferred<void>()
    registryHold = lookup.promise

    const first = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    const second = await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c")
    await flushMicrotasks(5)
    await cancelTask(first)
    lookup.resolve()
    await flushMicrotasks(20)

    expect(mockExecuteMerge.mock.calls.map((c) => c[1].slugs)).toEqual([["c", "d"]])
    expect(getQueue().map((t) => [t.id, t.status])).toEqual([[second, "processing"]])
    await cancelTask(second)
    expect(signals[0].aborted).toBe(true)
  })

  it("a merge whose project lookup ends while an earlier retried merge runs does not start beside it (#35)", async () => {
    mockExecuteMerge
      .mockRejectedValueOnce(new MergeReplyRejectedError("test"))
      .mockImplementation(() => new Promise<MergeResult>(() => {}))
    const retried = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(20)
    expect(getQueue()[0].status).toBe("failed")

    const lookup = createDeferred<void>()
    registryHold = lookup.promise
    const later = await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c")
    await flushMicrotasks(5)
    registryHold = null
    await retryTask(retried)
    await flushMicrotasks(20)
    lookup.resolve()
    await flushMicrotasks(20)

    expect(mockExecuteMerge.mock.calls.map((c) => c[1].slugs)).toEqual([["a", "b"], ["a", "b"]])
    expect(getQueue().map((t) => [t.id, t.status])).toEqual([
      [retried, "processing"],
      [later, "pending"],
    ])
  })

  it("a merge that failed for good while the queue looked up its project does not run again (#35)", async () => {
    mockExecuteMerge.mockRejectedValueOnce(new MergeReplyRejectedError("test"))
    const lookup = createDeferred<void>()
    registryHold = lookup.promise
    const id = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(5)
    registryHold = null
    resumeProcessing()
    await flushMicrotasks(20)
    lookup.resolve()
    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledOnce()
    expect(getQueue().map((t) => [t.id, t.status])).toEqual([[id, "failed"]])
  })
})

describe("dedup-queue — pauseQueue / restoreQueue", () => {
  it("pauseQueue persists state, restoreQueue brings it back", async () => {
    let captured = ""
    mockWriteFile.mockImplementation(async (path: string, content: string) => {
      if (path.includes("dedup-queue.json") && path.startsWith(TEST_PATH)) {
        captured = content
      }
    })
    // Hold execution so the task stays pending across pause.
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(5)

    await pauseQueue()
    expect(getQueue()).toHaveLength(0)
    expect(captured).toContain("\"status\": \"pending\"")

    // Restore: read returns the captured content.
    mockReadFile.mockImplementation(async (path: string) => {
      if (path.startsWith(TEST_PATH)) return captured
      throw new Error("ENOENT")
    })

    await restoreQueue(TEST_ID, TEST_PATH)
    const restored = getQueue()
    expect(restored).toHaveLength(1)
    expect(restored[0].group.slugs).toEqual(["a", "b"])
  })

  it("restoreQueue reverts processing tasks to pending without auto-running them", async () => {
    const persisted = JSON.stringify([
      {
        id: "dedup-old",
        projectId: TEST_ID,
        group: { slugs: ["a", "b"], confidence: "high", reason: "x" },
        canonicalSlug: "a",
        status: "processing",
        addedAt: 1,
        error: null,
        retryCount: 0,
      },
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.startsWith(TEST_PATH) ? persisted : Promise.reject(new Error("ENOENT")),
    )
    mockExecuteMerge.mockResolvedValue({
      canonicalContent: "",
      canonicalPath: "",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(20)

    expect(mockExecuteMerge).not.toHaveBeenCalled()
    const restored = getQueue()
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      id: "dedup-old",
      status: "pending",
    })
    expect(getQueueSummary().restoredBacklogWaiting).toBe(true)
  })

  it("runs new live merge tasks while restored backlog waits", async () => {
    const persisted = JSON.stringify([
      {
        id: "dedup-restored",
        projectId: TEST_ID,
        group: { slugs: ["old-a", "old-b"], confidence: "high", reason: "x" },
        canonicalSlug: "old-a",
        status: "pending",
        addedAt: 1,
        error: null,
        retryCount: 0,
      },
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.startsWith(TEST_PATH) ? persisted : Promise.reject(new Error("ENOENT")),
    )
    mockExecuteMerge.mockResolvedValue({
      canonicalContent: "",
      canonicalPath: "",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(5)
    expect(mockExecuteMerge).not.toHaveBeenCalled()

    await enqueueMerge(TEST_ID, makeGroup(["new-a", "new-b"]), "new-a")
    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledOnce()
    expect(mockExecuteMerge.mock.calls[0][1].slugs).toEqual(["new-a", "new-b"])
    expect(getQueue().map((task) => task.id)).toEqual(["dedup-restored"])
    expect(getQueueSummary().restoredBacklogWaiting).toBe(true)
  })

  it("promotes a restored merge when a live enqueue touches the same group", async () => {
    const persisted = JSON.stringify([
      {
        id: "dedup-restored",
        projectId: TEST_ID,
        group: { slugs: ["a", "b"], confidence: "high", reason: "old" },
        canonicalSlug: "a",
        status: "pending",
        addedAt: 1,
        error: null,
        retryCount: 0,
      },
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.startsWith(TEST_PATH) ? persisted : Promise.reject(new Error("ENOENT")),
    )
    mockExecuteMerge.mockResolvedValue({
      canonicalContent: "",
      canonicalPath: "",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    await restoreQueue(TEST_ID, TEST_PATH)
    const id = await enqueueMerge(TEST_ID, makeGroup(["b", "a"]), "b")
    await flushMicrotasks(20)

    expect(id).toBe("dedup-restored")
    expect(mockExecuteMerge).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
    expect(getQueueSummary().restoredBacklogWaiting).toBe(false)
  })

  it("resumeProcessing runs restored pending merge tasks", async () => {
    const persisted = JSON.stringify([
      {
        id: "dedup-restored",
        projectId: TEST_ID,
        group: { slugs: ["a", "b"], confidence: "high", reason: "x" },
        canonicalSlug: "a",
        status: "pending",
        addedAt: 1,
        error: null,
        retryCount: 0,
      },
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.startsWith(TEST_PATH) ? persisted : Promise.reject(new Error("ENOENT")),
    )
    mockExecuteMerge.mockResolvedValue({
      canonicalContent: "",
      canonicalPath: "",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(5)
    expect(mockExecuteMerge).not.toHaveBeenCalled()

    resumeProcessing()
    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledOnce()
    expect(getQueue()).toHaveLength(0)
  })

  it("runs a restored scheduled merge with no resume while a restored hand merge still waits", async () => {
    const persisted = JSON.stringify([
      {
        id: "dedup-by-hand",
        projectId: TEST_ID,
        group: { slugs: ["hand-a", "hand-b"], confidence: "medium", reason: "x" },
        canonicalSlug: "hand-a",
        status: "pending",
        addedAt: 1,
        error: null,
        retryCount: 0,
      },
      {
        id: "dedup-scheduled",
        projectId: TEST_ID,
        group: { slugs: ["sched-a", "sched-b"], confidence: "high", reason: "x" },
        canonicalSlug: "sched-a",
        status: "processing",
        addedAt: 2,
        error: null,
        retryCount: 0,
        scheduled: true,
      },
      {
        id: "dedup-scheduled-failed",
        projectId: TEST_ID,
        group: { slugs: ["gone-a", "gone-b"], confidence: "high", reason: "x" },
        canonicalSlug: "gone-a",
        status: "failed",
        addedAt: 3,
        error: "merge model failed",
        retryCount: 3,
        scheduled: true,
      },
    ])
    mockReadFile.mockImplementation(async (path: string) =>
      path.startsWith(TEST_PATH) ? persisted : Promise.reject(new Error("ENOENT")),
    )
    mockExecuteMerge.mockResolvedValue({
      canonicalContent: "",
      canonicalPath: "",
      rewrites: [],
      pagesToDelete: [],
      backup: [],
    })

    await restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledOnce()
    expect(mockExecuteMerge.mock.calls[0][2]).toBe("sched-a")
    // A scheduled merge that had failed for good stays failed.
    expect(getQueue().map((t) => [t.id, t.status])).toEqual([
      ["dedup-by-hand", "pending"],
      ["dedup-scheduled-failed", "failed"],
    ])
    expect(getQueueSummary().restoredBacklogWaiting).toBe(true)
  })

  it("does not leak tasks across project switch", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))

    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    expect(getQueueSummary().total).toBe(1)

    await pauseQueue()
    await restoreQueue(TEST_ID_B, TEST_PATH_B)
    expect(getQueueSummary().total).toBe(0)
  })

  it.each([
    // The project is no longer active, so the enqueue is refused.
    ["a scheduled enqueue", () => enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c", { scheduled: true }).catch(() => "")],
    ["the resume click", resumeProcessing],
  ])("%s while a project switch saves the queue starts no merge (#35)", async (_label, trigger) => {
    // A merge ends when aborted, which frees the project lock.
    mockExecuteMerge.mockImplementation((_pp, _g, _slug, _llm, opts) =>
      new Promise<MergeResult>((_resolve, reject) => {
        opts!.signal!.addEventListener("abort", () => reject(new Error("aborted")))
      }),
    )
    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(5)
    expect(mockExecuteMerge).toHaveBeenCalledOnce()

    const save = createDeferred<void>()
    mockWriteFile.mockImplementationOnce(() => save.promise)
    const paused = pauseQueue()
    await trigger()
    await flushMicrotasks(20)
    save.resolve()
    await paused
    await restoreQueue(TEST_ID_B, TEST_PATH_B)
    await flushMicrotasks(20)

    expect(mockExecuteMerge).toHaveBeenCalledOnce()
  })

  it("a merge whose project lookup ends while a project switch saves the queue neither starts nor saves (#35)", async () => {
    const lookup = createDeferred<void>()
    registryHold = lookup.promise
    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    await flushMicrotasks(5)

    const save = createDeferred<void>()
    mockWriteFile.mockImplementationOnce(() => save.promise)
    const writesBefore = mockWriteFile.mock.calls.length
    const paused = pauseQueue()
    lookup.resolve()
    await flushMicrotasks(20)
    save.resolve()
    await paused

    expect(mockExecuteMerge).not.toHaveBeenCalled()
    // Only the switch's own save, with the task left pending.
    const writes = mockWriteFile.mock.calls.slice(writesBefore)
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toContain('"pending"')
  })
})

describe("dedup-queue — overlapping project switches (#39)", () => {
  const FILE_A = `${TEST_PATH}/.llm-wiki/dedup-queue.json`
  const FILE_B = `${TEST_PATH_B}/.llm-wiki/dedup-queue.json`
  let files: Map<string, string>

  /** A queue file holding one pending hand-queued merge. */
  function queueFileWith(projectId: string, slugs: string[]): string {
    return JSON.stringify([{
      id: `saved-${slugs.join("-")}`,
      projectId,
      group: makeGroup(slugs),
      canonicalSlug: slugs[0],
      status: "pending",
      addedAt: 1,
      error: null,
      retryCount: 0,
    }])
  }

  /** Hold the next queue write until the returned deferred resolves. */
  function holdNextWrite(): Deferred<void> {
    const held = createDeferred<void>()
    mockWriteFile.mockImplementationOnce(async (path: string, content: string) => {
      await held.promise
      files.set(path, content)
    })
    return held
  }

  beforeEach(() => {
    files = new Map()
    mockReadFile.mockImplementation(async (path: string) => {
      const content = files.get(path)
      if (content === undefined) throw new Error("ENOENT")
      return content
    })
    mockWriteFile.mockImplementation(async (path: string, content: string) => {
      files.set(path, content)
    })
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
  })

  it("a second switch made while the first one saves keeps the next project's restored merges", async () => {
    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    files.set(FILE_B, queueFileWith(TEST_ID_B, ["c", "d"]))

    const save = holdNextWrite()
    const firstPause = pauseQueue()
    const secondPause = pauseQueue()
    const restoreB = restoreQueue(TEST_ID_B, TEST_PATH_B)
    await flushMicrotasks(20)
    save.resolve()
    await Promise.all([firstPause, secondPause, restoreB])

    expect(getQueue().map((t) => t.group.slugs)).toEqual([["c", "d"]])
    // The next save in project B still carries the restored merge.
    await enqueueMerge(TEST_ID_B, makeGroup(["e", "f"]), "e")
    expect(files.get(FILE_B)).toContain('"c"')
    expect(files.get(FILE_A)).toContain('"a"')
  })

  it("reopening a project while its switch saves reads the queue file once the save lands", async () => {
    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")

    const save = holdNextWrite()
    const paused = pauseQueue()
    const reopened = restoreQueue(TEST_ID, TEST_PATH)
    await flushMicrotasks(20)
    save.resolve()
    await Promise.all([paused, reopened])

    expect(getQueue().map((t) => t.group.slugs)).toEqual([["a", "b"]])
    await enqueueMerge(TEST_ID, makeGroup(["e", "f"]), "e")
    expect(files.get(FILE_A)).toContain('"a"')
  })

  it("a switch made while a project's queue file is read saves that project's merges, not an empty queue", async () => {
    await pauseQueue()
    files.set(FILE_B, queueFileWith(TEST_ID_B, ["c", "d"]))
    const read = createDeferred<void>()
    mockReadFile.mockImplementationOnce(async (path: string) => {
      await read.promise
      return files.get(path)!
    })

    const restoreB = restoreQueue(TEST_ID_B, TEST_PATH_B)
    const paused = pauseQueue()
    await flushMicrotasks(20)
    read.resolve()
    await Promise.all([restoreB, paused])

    expect(getQueue()).toHaveLength(0)
    expect(files.get(FILE_B)).toContain('"c"')
  })

  it("a restore that throws still lets the switch queued behind it run", async () => {
    await pauseQueue()
    files.set(FILE_B, queueFileWith("another-project", ["c", "d"]))
    const read = createDeferred<void>()
    mockReadFile.mockImplementationOnce(async (path: string) => {
      await read.promise
      return files.get(path)!
    })
    // The restore warns that it dropped the other project's task.
    const warn = vi.spyOn(console, "warn").mockImplementationOnce(() => {
      throw new Error("boom")
    })

    try {
      const restoreB = restoreQueue(TEST_ID_B, TEST_PATH_B)
      const paused = pauseQueue()
      read.resolve()

      await expect(restoreB).rejects.toThrow("boom")
      await expect(paused).resolves.toBeUndefined()
      // The pause ran: project B is no longer active.
      await expect(enqueueMerge(TEST_ID_B, makeGroup(["e", "f"]), "e")).rejects.toThrow("not the active project")
    } finally {
      warn.mockRestore()
    }
  })

  it("a switch left running across a state wipe does not let the next pause past a restore still reading", async () => {
    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    const save = holdNextWrite()
    const stalePause = pauseQueue()
    clearQueueState()

    files.set(FILE_B, queueFileWith(TEST_ID_B, ["c", "d"]))
    const read = createDeferred<void>()
    mockReadFile.mockImplementationOnce(async (path: string) => {
      await read.promise
      return files.get(path)!
    })
    const restoreB = restoreQueue(TEST_ID_B, TEST_PATH_B)
    save.resolve()
    await stalePause
    const paused = pauseQueue()
    await flushMicrotasks(20)
    read.resolve()
    await Promise.all([restoreB, paused])

    expect(files.get(FILE_B)).toContain('"c"')
  })

  describe("time limits, and a restore over an open project (#43)", () => {
    let consoleError: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    })

    afterEach(() => {
      vi.useRealTimers()
      consoleError.mockRestore()
    })

    it("a pause whose save never settles fails alone at the time limit, logs a named error, and lets the restore behind it run", async () => {
      await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
      await flushMicrotasks(20)
      files.set(FILE_B, queueFileWith(TEST_ID_B, ["c", "d"]))
      mockWriteFile.mockImplementationOnce(() => new Promise(() => {}))

      const paused = pauseQueue().catch((err: unknown) => err)
      const restoreB = restoreQueue(TEST_ID_B, TEST_PATH_B)
      await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)

      expect(await paused).toBeInstanceOf(SwitchStepTimeoutError)
      await restoreB
      expect(getQueue().map((t) => t.group.slugs)).toEqual([["c", "d"]])
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("SwitchStepTimeoutError"))
    })

    it("a pause whose save settles just inside the time limit succeeds", async () => {
      await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
      await flushMicrotasks(20)
      const save = holdNextWrite()

      const paused = pauseQueue()
      await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS - 1)
      save.resolve()

      await expect(paused).resolves.toBeUndefined()
      expect(files.get(FILE_A)).toContain('"a"')
      expect(consoleError).not.toHaveBeenCalled()
    })

    it("a restore whose read never settles leaves no project open, and its late read changes nothing", async () => {
      await pauseQueue()
      files.set(FILE_B, queueFileWith(TEST_ID_B, ["c", "d"]))
      const read = createDeferred<void>()
      mockReadFile.mockImplementationOnce(async (path: string) => {
        await read.promise
        return files.get(path)!
      })

      const restoreB = restoreQueue(TEST_ID_B, TEST_PATH_B).catch((err: unknown) => err)
      const paused = pauseQueue()
      await vi.advanceTimersByTimeAsync(SWITCH_STEP_TIMEOUT_MS)

      expect(await restoreB).toBeInstanceOf(SwitchStepTimeoutError)
      await paused
      // The pause behind it saved no empty queue over project B's file.
      expect(files.get(FILE_B)).toContain('"c"')
      read.resolve()
      await flushMicrotasks(20)
      expect(getQueue()).toHaveLength(0)
      await expect(enqueueMerge(TEST_ID_B, makeGroup(["e", "f"]), "e")).rejects.toThrow("not the active project")
    })

    it("a restore made while another project's merge runs cancels that merge and saves its project before loading", async () => {
      await pauseQueue()
      await pauseQueue()
      // Project A's queue file holds a scheduled merge, which runs once A opens.
      const [scheduledTask] = JSON.parse(queueFileWith(TEST_ID, ["a", "b"]))
      files.set(FILE_A, JSON.stringify([{ ...scheduledTask, scheduled: true }]))
      files.set(FILE_B, queueFileWith(TEST_ID_B, ["c", "d"]))
      await restoreQueue(TEST_ID, TEST_PATH)
      await vi.waitFor(() => expect(mockExecuteMerge).toHaveBeenCalledTimes(1))
      const signal = mockExecuteMerge.mock.calls[0][4]!.signal!

      await restoreQueue(TEST_ID_B, TEST_PATH_B)

      expect(signal.aborted).toBe(true)
      expect(JSON.parse(files.get(FILE_A)!)[0].status).toBe("pending")
      expect(getQueue().map((t) => t.group.slugs)).toEqual([["c", "d"]])
    })

    it("a restore whose project is no longer the one opening when its turn comes leaves the queue alone", async () => {
      await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
      await flushMicrotasks(20)
      files.set(FILE_B, queueFileWith(TEST_ID_B, ["c", "d"]))
      let opening = TEST_ID_B
      const save = holdNextWrite()

      const paused = pauseQueue()
      const restoreB = restoreQueue(TEST_ID_B, TEST_PATH_B, () => opening === TEST_ID_B)
      // The user moved on before project B's restore had its turn.
      opening = TEST_ID
      save.resolve()
      await Promise.all([paused, restoreB])

      expect(getQueue()).toHaveLength(0)
      await expect(enqueueMerge(TEST_ID_B, makeGroup(["e", "f"]), "e")).rejects.toThrow("not the active project")
    })

    it("a restore whose project is no longer the one opening leaves the open project and its merge running", async () => {
      await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
      await vi.waitFor(() => expect(mockExecuteMerge).toHaveBeenCalledTimes(1))
      const signal = mockExecuteMerge.mock.calls[0][4]!.signal!

      await restoreQueue(TEST_ID_B, TEST_PATH_B, () => false)

      expect(signal.aborted).toBe(false)
      expect(getQueue().map((t) => t.group.slugs)).toEqual([["a", "b"]])
      await expect(enqueueMerge(TEST_ID, makeGroup(["e", "f"]), "e")).resolves.toBeTruthy()
    })

    it("a restore whose project stops being the one opening while the open project saves loads nothing", async () => {
      await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
      await flushMicrotasks(20)
      files.set(FILE_B, queueFileWith(TEST_ID_B, ["c", "d"]))
      let opening = TEST_ID_B
      const save = holdNextWrite()

      const restoreB = restoreQueue(TEST_ID_B, TEST_PATH_B, () => opening === TEST_ID_B)
      await flushMicrotasks(20)
      opening = TEST_ID
      save.resolve()
      await restoreB

      expect(files.get(FILE_A)).toContain('"a"')
      expect(getQueue()).toHaveLength(0)
      await expect(enqueueMerge(TEST_ID_B, makeGroup(["e", "f"]), "e")).rejects.toThrow("not the active project")
    })
  })
})

describe("dedup-queue — outcomes a scheduled run waits for", () => {
  const merged = {
    canonicalContent: "",
    canonicalPath: "",
    rewrites: [],
    pagesToDelete: [],
    backup: [],
  }

  it("reports done, and failed after the last retry", async () => {
    mockExecuteMerge.mockImplementation(async (_pp, g) => {
      if (g.slugs.includes("bad")) throw new Error("boom")
      return merged
    })

    const ok = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a", { scheduled: true })
    const bad = await enqueueMerge(TEST_ID, makeGroup(["bad", "worse"]), "bad", { scheduled: true })

    expect(await waitForTask(ok)).toBe("done")
    expect(await waitForTask(bad)).toBe("failed")
  })

  it("reports cancelled when the merge is cancelled by hand", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
    await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a")
    const id = await enqueueMerge(TEST_ID, makeGroup(["c", "d"]), "c", { scheduled: true })
    const outcome = waitForTask(id)

    await cancelTask(id)

    expect(await outcome).toBe("cancelled")
  })

  it("reports interrupted when the project is switched mid-merge", async () => {
    mockExecuteMerge.mockImplementation(() => new Promise(() => {}))
    const id = await enqueueMerge(TEST_ID, makeGroup(["a", "b"]), "a", { scheduled: true })
    const outcome = waitForTask(id)
    await flushMicrotasks(20)

    await pauseQueue()

    expect(await outcome).toBe("interrupted")
  })
})
