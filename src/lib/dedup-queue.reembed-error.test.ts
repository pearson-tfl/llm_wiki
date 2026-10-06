/**
 * #80: a merge already reported done stays done when its re-embed throws.
 * #82: a re-embed that throws after a cancel is logged as its own failure.
 * Runs the real merge queue and the real `reembedMergedPages` against a
 * real temporary project; only `executeMerge` is replaced, the Tauri
 * vector-store and embedding commands are an in-memory store, and the
 * write of the embedded-pages record throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"
import { createDeferred, flushIO, waitFor } from "@/test-helpers/deferred"

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeVectorStore> | null }))
const project = vi.hoisted(() => ({ path: "" }))

vi.mock("@/commands/fs", () => realFs)
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => store.current!.invoke(cmd, args),
}))
vi.mock("./dedup-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dedup-runner")>()),
  executeMerge: vi.fn(),
}))
vi.mock("@/lib/embedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embedding")>()),
  recordEmbeddedHashes: vi.fn(async () => {
    throw new Error("EACCES: permission denied, open '.llm-wiki/embedded-pages.json'")
  }),
}))
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async () => project.path),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import { cancelTask, clearQueueState, enqueueMerge, restoreQueue, waitForTask } from "./dedup-queue"
import { executeMerge } from "./dedup-runner"
import { recordEmbeddedHashes } from "@/lib/embedding"
import { __resetProjectLocksForTesting } from "./project-mutex"
import { useWikiStore } from "@/stores/wiki-store"

const PROJECT_ID = "reembed-error-project"
const mockExecuteMerge = vi.mocked(executeMerge)
const mockRecord = vi.mocked(recordEmbeddedHashes)

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  tmp = await createTempProject("dedup-queue-reembed-error")
  project.path = tmp.path
  store.current = createFakeVectorStore()
  clearQueueState()
  __resetProjectLocksForTesting()
  mockExecuteMerge.mockReset()
  mockRecord.mockClear()
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })
  useWikiStore.getState().setEmbeddingConfig({
    enabled: true,
    endpoint: "http://127.0.0.1:1234/v1/embeddings",
    apiKey: "",
    model: "test-embedder",
  })
  await writeFileRaw(
    `${tmp.path}/wiki/concepts/echo-loop.md`,
    ["---", "type: concept", "title: Echo loop", "---", "Peers suppress echoed replies.", ""].join("\n"),
  )
  await restoreQueue(PROJECT_ID, tmp.path)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await tmp.cleanup()
})

describe("dedup-queue – a re-embed that throws after the merge is done (#80)", () => {
  it("leaves the merge done: no retry, and no failed outcome after done", async () => {
    const log = vi.spyOn(console, "log")
    const warn = vi.spyOn(console, "warn")
    // Two failed attempts first, so one more failure would be the last
    // retry and report the task failed.
    mockExecuteMerge
      .mockRejectedValueOnce(new Error("model timed out"))
      .mockRejectedValueOnce(new Error("model timed out"))
      .mockResolvedValue({
        canonicalContent: "",
        canonicalPath: "wiki/concepts/echo-loop.md",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      })

    const id = await enqueueMerge(PROJECT_ID, { slugs: ["echo-loop", "echo-loops"], confidence: "high", reason: "test" }, "echo-loop", { scheduled: true })

    expect(await waitForTask(id)).toBe("done")
    await waitFor(() => mockRecord.mock.calls.length > 0)
    await flushIO(20)

    expect(mockExecuteMerge).toHaveBeenCalledTimes(3)
    const queueLines = log.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith("[Dedup Queue]"))
    expect(queueLines.slice(queueLines.findIndex((m) => m.startsWith("[Dedup Queue] Done")))).toEqual([
      "[Dedup Queue] Done: echo-loop,echo-loops",
    ])
    // No outcome is left behind for the next waiter to read.
    expect(await waitForTask(id)).toBe("interrupted")
    expect(warn.mock.calls.map(([m]) => String(m))).toContain(
      "[Dedup Queue] Re-embed after merging echo-loop,echo-loops failed: EACCES: permission denied, open '.llm-wiki/embedded-pages.json'",
    )
  })

  it("logs a re-embed that throws after a cancel as the re-embed's failure, not the cancel (#82)", async () => {
    const log = vi.spyOn(console, "log")
    const warn = vi.spyOn(console, "warn")
    const merging = createDeferred<void>()
    mockExecuteMerge.mockImplementation(async () => {
      await merging.promise
      return {
        canonicalContent: "",
        canonicalPath: "wiki/concepts/echo-loop.md",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      }
    })

    const id = await enqueueMerge(PROJECT_ID, { slugs: ["echo-loop", "echo-loops"], confidence: "high", reason: "test" }, "echo-loop")
    await waitFor(() => mockExecuteMerge.mock.calls.length > 0)
    // The cancel lands while the merge writes; the pages it wrote are
    // still re-embedded.
    await cancelTask(id)
    merging.resolve()
    await waitFor(() => mockRecord.mock.calls.length > 0)
    await flushIO(20)

    expect(warn.mock.calls.map(([m]) => String(m))).toContain(
      "[Dedup Queue] Re-embed after merging echo-loop,echo-loops failed: EACCES: permission denied, open '.llm-wiki/embedded-pages.json'",
    )
    expect(log.mock.calls.map(([m]) => String(m)).filter((m) => m.startsWith("[Dedup Queue] Cancelled"))).toEqual([])
  })
})
