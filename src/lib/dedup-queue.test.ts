import { describe, it, expect, beforeEach, vi } from "vitest"
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
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => idToPath[id] ?? null),
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
} from "./dedup-queue"
import { executeMerge } from "./dedup-runner"
import { readFile, writeFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { __resetProjectLocksForTesting } from "./project-mutex"
import type { DuplicateGroup, MergeResult } from "./dedup"

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
