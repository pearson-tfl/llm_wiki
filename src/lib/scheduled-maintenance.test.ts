/**
 * Seam 2 of #16 (tickets #18, #19): the scheduled maintenance tick, called
 * with an explicit clock against a real temporary project. Detection, merge
 * and the model call are faked at the dedup runner boundary, and the
 * embedding search at its own; the merge queue, the not-duplicates list,
 * the saved-groups file, the hub-rebuild request and archive, the page
 * history, the run record and the review sweep are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createDeferred, waitFor } from "@/test-helpers/deferred"

const storage = vi.hoisted(() => new Map<string, unknown>())
const ingestSummary = vi.hoisted(() => ({ pending: 0, processing: 0, busyFromRead: Infinity, reads: 0 }))

vi.mock("@/commands/fs", () => realFs)

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => storage.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      storage.set(key, value)
    },
    delete: async (key: string) => {
      storage.delete(key)
    },
    save: async () => undefined,
  })),
}))

vi.mock("@/lib/dedup-runner", () => ({
  runDuplicateDetection: vi.fn(),
  executeMerge: vi.fn(),
  buildDedupLlmCall: vi.fn(),
}))

vi.mock("@/lib/embedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./embedding")>()),
  searchByEmbedding: vi.fn(),
  getLastEmbeddingError: vi.fn(),
}))

// `busyFromRead` counts the tick's own reads of the summary. The merge
// queue asks `isIngestActive`, which sees only `pending` and `processing`.
vi.mock("@/lib/ingest-queue", () => ({
  isIngestActive: () => ingestSummary.pending + ingestSummary.processing > 0,
  getQueueSummary: () => {
    ingestSummary.reads += 1
    const busy = ingestSummary.reads >= ingestSummary.busyFromRead ? 1 : 0
    return { pending: ingestSummary.pending + busy, processing: ingestSummary.processing }
  },
}))

import { buildDedupLlmCall, executeMerge, runDuplicateDetection } from "@/lib/dedup-runner"
import { getLastEmbeddingError, searchByEmbedding } from "@/lib/embedding"
import {
  clearQueueState,
  getQueue,
  restoreQueue,
} from "@/lib/dedup-queue"
import {
  addNotDuplicate,
  loadPendingDuplicateGroups,
  removePendingDuplicateGroup,
} from "@/lib/dedup-storage"
import {
  loadScheduledMaintenanceConfig,
  saveScheduledMaintenanceConfig,
} from "@/lib/project-store"
import {
  runMaintenanceTick,
  startScheduledMaintenance,
  stopScheduledMaintenance,
} from "./scheduled-maintenance"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { MergeReplyRejectedError, type DuplicateGroup } from "./dedup"
import type { WikiProject } from "@/types/wiki"

const mockDetect = vi.mocked(runDuplicateDetection)
const mockMerge = vi.mocked(executeMerge)
const mockBuildLlm = vi.mocked(buildDedupLlmCall)
const mockSearch = vi.mocked(searchByEmbedding)
const mockEmbeddingError = vi.mocked(getLastEmbeddingError)
/** The model call the hub rebuild makes: (system, user) → reply. */
const mockModel = vi.fn<(system: string, user: string) => Promise<string>>()

const HOUR = 60 * 60 * 1000
const T0 = Date.parse("2026-10-05T09:00:00Z")
const PROJECT_ID = "maint-project-id"

let tmp: { path: string; cleanup: () => Promise<void> }
let project: WikiProject

/** Front matter shaped like the live Agent Harness Wiki vault's
 *  concept pages (wiki/concepts/a2a-echo-loop-suppression.md). */
function page(title: string, created: string, sources: string[]): string {
  return [
    "---",
    "type: concept",
    `title: ${title}`,
    `created: ${created}`,
    `updated: ${created}`,
    "tags: [agent-to-agent, delivery]",
    "related: []",
    `sources: [${sources.map((s) => JSON.stringify(s)).join(", ")}]`,
    "---",
    `# ${title}`,
    "",
    `${title} body.`,
    "",
  ].join("\n")
}

function group(slugs: string[], confidence: DuplicateGroup["confidence"]): DuplicateGroup {
  return { slugs, confidence, reason: "same topic" }
}

async function runRecords(): Promise<Record<string, unknown>[]> {
  const raw = await readFileRaw(`${tmp.path}/.llm-wiki/maintenance-runs.jsonl`)
  return raw.trim().split("\n").map((line) => JSON.parse(line))
}

async function setConfig(lastRun: number | null, enabled = true, intervalHours = 24) {
  await saveScheduledMaintenanceConfig(tmp.path, { enabled, intervalHours, lastRun })
}

beforeEach(async () => {
  tmp = await createTempProject("sched-maint")
  project = { id: PROJECT_ID, name: "maint", path: tmp.path }
  storage.clear()
  storage.set("projectRegistry", {
    [PROJECT_ID]: { id: PROJECT_ID, path: tmp.path, name: "maint", lastOpened: T0 },
  })
  ingestSummary.pending = 0
  ingestSummary.processing = 0
  ingestSummary.busyFromRead = Infinity
  ingestSummary.reads = 0
  mockDetect.mockReset()
  mockMerge.mockReset()
  mockDetect.mockResolvedValue([])
  mockSearch.mockReset()
  mockEmbeddingError.mockReset()
  mockEmbeddingError.mockReturnValue(null)
  mockModel.mockReset()
  mockBuildLlm.mockReset()
  mockBuildLlm.mockReturnValue((system, user) => mockModel(system, user))

  useWikiStore.getState().setProject(project)
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
    endpoint: "http://embed.invalid",
    apiKey: "",
    model: "fake-embed",
  })
  useReviewStore.getState().setItems([])

  clearQueueState()
  await restoreQueue(PROJECT_ID, tmp.path)
})

afterEach(async () => {
  clearQueueState()
  await tmp.cleanup()
})

describe("scheduled maintenance tick – when it acts", () => {
  it("runs the duplicate scan when due and not before", async () => {
    await setConfig(T0)

    const early = await runMaintenanceTick(project, { now: () => T0 + 23 * HOUR })
    expect(early).toBeNull()
    expect(mockDetect).not.toHaveBeenCalled()

    const due = await runMaintenanceTick(project, { now: () => T0 + 24 * HOUR })
    expect(due?.skipReason).toBeNull()
    expect(mockDetect).toHaveBeenCalledOnce()
    expect((await loadScheduledMaintenanceConfig(tmp.path)).lastRun).toBe(T0 + 24 * HOUR)
  })
})

describe("scheduled maintenance tick – skips, with the reason recorded", () => {
  it("skips while the ingest queue has pending items, and again while one is processing", async () => {
    await setConfig(null)

    ingestSummary.pending = 1
    const pending = await runMaintenanceTick(project, { now: () => T0 })
    ingestSummary.pending = 0
    ingestSummary.processing = 1
    const processing = await runMaintenanceTick(project, { now: () => T0 + 1 })

    expect(pending?.skipReason).toBe("ingest-busy")
    expect(processing?.skipReason).toBe("ingest-busy")
    expect(mockDetect).not.toHaveBeenCalled()
    expect((await runRecords()).map((r) => r.skipReason)).toEqual(["ingest-busy", "ingest-busy"])
    // A skip does not count as a run: the job stays due.
    expect((await loadScheduledMaintenanceConfig(tmp.path)).lastRun).toBeNull()
  })

  it("skips while a previous tick is still running", async () => {
    await setConfig(null)
    const held = createDeferred<DuplicateGroup[]>()
    mockDetect.mockReturnValueOnce(held.promise)

    const first = runMaintenanceTick(project, { now: () => T0 })
    await waitFor(() => mockDetect.mock.calls.length === 1)
    const second = await runMaintenanceTick(project, { now: () => T0 + 1 })
    held.resolve([])
    await first

    expect(second?.skipReason).toBe("previous-tick-running")
    expect(mockDetect).toHaveBeenCalledOnce()
    expect((await runRecords()).map((r) => r.skipReason)).toEqual(["previous-tick-running", null])
  })

  it("skips when no usable model is configured", async () => {
    await setConfig(null)
    useWikiStore.getState().setLlmConfig({
      ...useWikiStore.getState().llmConfig,
      provider: "openai",
      apiKey: "",
    })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(record?.skipReason).toBe("no-model")
    expect(mockDetect).not.toHaveBeenCalled()
    expect((await runRecords()).map((r) => r.skipReason)).toEqual(["no-model"])
  })
})

describe("scheduled maintenance tick – duplicate scan", () => {
  /** Fake merge at the runner boundary: on the real disk, keep the
   *  canonical page and delete the merged-away ones, as executeMerge does. */
  function mergeOnDisk(failSlugs: string[] = []) {
    mockMerge.mockImplementation(async (pp, g, canonicalSlug) => {
      if (g.slugs.some((s) => failSlugs.includes(s))) throw new Error("merge model failed")
      for (const slug of g.slugs) {
        if (slug !== canonicalSlug) await realFs.deleteFile(`${pp}/wiki/concepts/${slug}.md`)
      }
      return {
        canonicalPath: `wiki/concepts/${canonicalSlug}.md`,
        canonicalContent: "",
        rewrites: [],
        pagesToDelete: [],
        backup: [],
      }
    })
  }

  it("merges each high-confidence group with the deterministic canonical page, with no resume call", async () => {
    await setConfig(null)
    // Most sources wins.
    await writeFileRaw(`${tmp.path}/wiki/concepts/agent-loop.md`, page("Agent Loop", "2026-09-01", ["a.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/agent-loops.md`, page("Agent Loops", "2026-10-04", ["a.md", "b.md"]))
    // Equal sources: earliest created date wins.
    await writeFileRaw(`${tmp.path}/wiki/concepts/hook-new.md`, page("Hook", "2026-10-01", ["c.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/hook-old.md`, page("Hooks", "2026-09-15", ["d.md"]))
    // Equal sources and dates: first in the group wins.
    await writeFileRaw(`${tmp.path}/wiki/concepts/lane-b.md`, page("Lane", "2026-10-02", ["e.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/lane-a.md`, page("Lanes", "2026-10-02", ["f.md"]))
    // One whose merge fails every retry.
    await writeFileRaw(`${tmp.path}/wiki/concepts/seat-one.md`, page("Seat", "2026-10-02", ["g.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/seat-two.md`, page("Seats", "2026-10-03", ["h.md"]))
    mockDetect.mockResolvedValue([
      group(["agent-loop", "agent-loops"], "high"),
      group(["hook-new", "hook-old"], "high"),
      group(["lane-b", "lane-a"], "high"),
      group(["seat-one", "seat-two"], "high"),
    ])
    mergeOnDisk(["seat-one"])

    const record = await runMaintenanceTick(project, { now: () => T0 })

    const merged = new Map<string, string>()
    for (const [, g, canonical] of mockMerge.mock.calls) merged.set(g.slugs.join(","), canonical)
    expect(Object.fromEntries(merged)).toEqual({
      "agent-loop,agent-loops": "agent-loops",
      "hook-new,hook-old": "hook-old",
      "lane-b,lane-a": "lane-b",
      "seat-one,seat-two": "seat-one",
    })
    expect(record).toMatchObject({
      groupsFound: { high: 4, medium: 0, low: 0 },
      mergesEnqueued: 4,
      mergesDone: 3,
      mergesFailed: 1,
    })
    expect(await realFs.fileExists(`${tmp.path}/wiki/concepts/agent-loop.md`)).toBe(false)
    expect(await realFs.fileExists(`${tmp.path}/wiki/concepts/agent-loops.md`)).toBe(true)
    // Only the failed merge is left on the queue.
    expect(getQueue().map((t) => [t.canonicalSlug, t.status])).toEqual([["seat-one", "failed"]])
  })

  it("records a merge whose reply was rejected, apart from the merges that failed", async () => {
    await setConfig(null)
    await writeFileRaw(`${tmp.path}/wiki/concepts/agent-loop.md`, page("Agent Loop", "2026-09-01", ["a.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/agent-loops.md`, page("Agent Loops", "2026-10-04", ["a.md", "b.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/seat-one.md`, page("Seat", "2026-10-02", ["g.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/seat-two.md`, page("Seats", "2026-10-03", ["h.md"]))
    mockDetect.mockResolvedValue([
      group(["agent-loop", "agent-loops"], "high"),
      group(["seat-one", "seat-two"], "high"),
    ])
    mergeOnDisk()
    const merge = mockMerge.getMockImplementation()!
    mockMerge.mockImplementation(async (...args) => {
      if (args[1].slugs.includes("seat-one")) throw new MergeReplyRejectedError("the model's reply was empty")
      return merge(...args)
    })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(record).toMatchObject({
      mergesEnqueued: 2,
      mergesDone: 1,
      mergesFailed: 0,
      mergesRejected: 1,
      rejectedMerges: [
        { slugs: ["seat-one", "seat-two"], reason: "Merge reply rejected: the model's reply was empty" },
      ],
    })
    expect((await runRecords())[0]).toMatchObject({ mergesRejected: 1 })
    // Not retried: the model is not asked again for the same group.
    expect(mockMerge.mock.calls.filter((c) => c[1].slugs.includes("seat-one"))).toHaveLength(1)
    expect(useReviewStore.getState().items).toMatchObject([
      { type: "duplicate", title: "Duplicate merge rejected: seat-one, seat-two", resolved: false },
    ])
  })
})

describe("scheduled maintenance tick – canonical page edge cases", () => {
  it("ranks a page with no page on disk, no sources or no created date below a dated page, in any wiki folder", async () => {
    await setConfig(null)
    // Live front matter carries a non-empty related list and nested folders.
    const dated = page("Codex Bridge", "2026-10-03", ["x.md"]).replace("related: []", "related: [openclaw, agent-client-protocol]")
    const undated = page("Codex-Bridge", "2026-10-01", ["y.md"]).replace(/^created: .*\n/m, "")
    const noSources = page("Codex Bridges", "2026-01-01", []).replace(/^sources: .*\n/m, "")
    await writeFileRaw(`${tmp.path}/wiki/entities/tools/codex-bridge.md`, dated)
    await writeFileRaw(`${tmp.path}/wiki/entities/codex-bridge-x.md`, undated)
    await writeFileRaw(`${tmp.path}/wiki/concepts/codex-bridges.md`, noSources)
    mockDetect.mockResolvedValue([
      group(["missing-page", "codex-bridges", "codex-bridge-x", "codex-bridge"], "high"),
    ])
    mockMerge.mockResolvedValue({ canonicalPath: "", canonicalContent: "", rewrites: [], pagesToDelete: [], backup: [] })

    await runMaintenanceTick(project, { now: () => T0 })

    expect(mockMerge.mock.calls.map((c) => c[2])).toEqual(["codex-bridge"])
  })
})

describe("scheduled maintenance tick – groups it does not merge", () => {
  it("saves medium- and low-confidence groups for the Maintenance screen and merges none of them", async () => {
    await setConfig(null)
    const medium = group(["pstack", "p-stack"], "medium")
    const low = group(["seat", "lane"], "low")
    mockDetect.mockResolvedValue([medium, low])

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockMerge).not.toHaveBeenCalled()
    expect(getQueue()).toHaveLength(0)
    expect(record).toMatchObject({
      groupsFound: { high: 0, medium: 1, low: 1 },
      mergesEnqueued: 0,
    })
    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([medium, low])
  })

  it("never enqueues a high-confidence group holding a pair marked not duplicates", async () => {
    await setConfig(null)
    await addNotDuplicate(tmp.path, ["harness", "harnesses"])
    // The detector drops an exact match itself; a larger group that still
    // holds the pair is the tick's to refuse.
    const holdsPair = group(["harness", "harnesses", "agent-harness"], "high")
    mockDetect.mockResolvedValue([holdsPair])

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockMerge).not.toHaveBeenCalled()
    expect(getQueue()).toHaveLength(0)
    expect(record?.mergesEnqueued).toBe(0)
    // Kept for a decision by hand instead.
    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([holdsPair])
  })
})

describe("saved groups – the Maintenance screen's manual actions", () => {
  it("drops a saved group once Merge or Not duplicates acts on it, matching slugs in any order or case", async () => {
    await setConfig(null)
    const acted = group(["pstack", "p-stack"], "medium")
    const left = group(["seat", "lane"], "low")
    mockDetect.mockResolvedValue([acted, left])
    await runMaintenanceTick(project, { now: () => T0 })

    await removePendingDuplicateGroup(tmp.path, ["P-Stack", "pstack"])

    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([left])
  })
})

describe("scheduled maintenance tick – after merges", () => {
  it("closes the open duplicate review item whose page was merged away", async () => {
    await setConfig(null)
    await writeFileRaw(`${tmp.path}/wiki/concepts/agent-loop.md`, page("Agent Loop", "2026-09-01", ["a.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/agent-loops.md`, page("Agent Loops", "2026-10-04", ["a.md", "b.md"]))
    useReviewStore.getState().setItems([
      {
        id: "review-dup-1",
        type: "duplicate",
        title: "Agent Loop and Agent Loops overlap",
        description: "Two pages on one topic.",
        affectedPages: ["wiki/concepts/agent-loop.md", "wiki/concepts/agent-loops.md"],
        options: [],
        resolved: false,
        createdAt: T0,
      },
    ])
    mockDetect.mockResolvedValue([group(["agent-loop", "agent-loops"], "high")])
    mockMerge.mockImplementation(async (pp) => {
      await realFs.deleteFile(`${pp}/wiki/concepts/agent-loop.md`)
      return { canonicalPath: "", canonicalContent: "", rewrites: [], pagesToDelete: [], backup: [] }
    })

    await runMaintenanceTick(project, { now: () => T0 })

    expect(useReviewStore.getState().items[0]).toMatchObject({
      resolved: true,
      resolvedAction: "auto-resolved",
    })
  })

  it("appends one record per tick with start and finish times", async () => {
    await setConfig(null, true, 24)
    let clock = T0
    const now = () => clock++
    mockDetect.mockResolvedValue([group(["a", "b"], "low")])

    await runMaintenanceTick(project, { now })
    clock = T0 + 25 * HOUR
    await runMaintenanceTick(project, { now })

    const records = await runRecords()
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual({
      startedAt: "2026-10-05T09:00:00.000Z",
      finishedAt: "2026-10-05T09:00:00.001Z",
      skipReason: null,
      groupsFound: { high: 0, medium: 0, low: 1 },
      mergesEnqueued: 0,
      mergesDone: 0,
      mergesFailed: 0,
      mergesRejected: 0,
    })
    expect(records[1].startedAt).toBe("2026-10-06T10:00:00.000Z")
  })
})

describe("scheduled maintenance setting", () => {
  it("is on by default at 24 hours, and is held per project", async () => {
    expect(await loadScheduledMaintenanceConfig(tmp.path)).toEqual({
      enabled: true,
      intervalHours: 24,
      lastRun: null,
    })

    await saveScheduledMaintenanceConfig(tmp.path, { enabled: false, intervalHours: 6, lastRun: T0 })

    expect(await loadScheduledMaintenanceConfig(tmp.path)).toEqual({
      enabled: false,
      intervalHours: 6,
      lastRun: T0,
    })
    expect((await loadScheduledMaintenanceConfig(`${tmp.path}-other`)).enabled).toBe(true)
  })

  it("does not run while switched off, however overdue", async () => {
    await setConfig(null, false)

    expect(await runMaintenanceTick(project, { now: () => T0 })).toBeNull()
    expect(mockDetect).not.toHaveBeenCalled()
  })
})

describe("scheduled maintenance tick – a scan that fails", () => {
  it("records the error and counts as a run, so the scan is not re-spent at every check", async () => {
    await setConfig(null)
    mockDetect.mockRejectedValue(new Error("model unreachable"))

    const record = await runMaintenanceTick(project, { now: () => T0 })
    const again = await runMaintenanceTick(project, { now: () => T0 + HOUR })

    expect(record).toMatchObject({ skipReason: null, error: "model unreachable" })
    expect(again).toBeNull()
    expect((await runRecords()).map((r) => r.error)).toEqual(["model unreachable"])
  })
})

describe("scheduled maintenance timer", () => {
  afterEach(() => {
    stopScheduledMaintenance()
    vi.useRealTimers()
  })

  it("runs an overdue job when the wiki is opened, then checks on a timer until stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    vi.setSystemTime(T0)
    await setConfig(T0 - 25 * HOUR)

    startScheduledMaintenance(project)
    await waitFor(async () => (await loadScheduledMaintenanceConfig(tmp.path)).lastRun === T0)
    expect(mockDetect).toHaveBeenCalledTimes(1)

    vi.setSystemTime(T0 + 24 * HOUR)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    await waitFor(() => mockDetect.mock.calls.length === 2)

    stopScheduledMaintenance()
    vi.setSystemTime(T0 + 48 * HOUR)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mockDetect).toHaveBeenCalledTimes(2)
  })

  it("ticks for the open project only", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    await setConfig(null)
    useWikiStore.getState().setProject({ id: "another-project", name: "other", path: "/elsewhere" })

    startScheduledMaintenance(project)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(mockDetect).not.toHaveBeenCalled()
    expect(await realFs.fileExists(`${tmp.path}/.llm-wiki/maintenance-runs.jsonl`)).toBe(false)
  })
})

describe("scheduled maintenance tick – state that changes during the scan", () => {
  beforeEach(async () => {
    await writeFileRaw(`${tmp.path}/wiki/concepts/agent-loop.md`, page("Agent Loop", "2026-09-01", ["a.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/agent-loops.md`, page("Agent Loops", "2026-10-04", ["a.md", "b.md"]))
  })

  it("withholds merges when an ingest starts while the scan runs", async () => {
    await setConfig(null)
    mockDetect.mockImplementation(async () => {
      ingestSummary.pending = 1
      return [group(["agent-loop", "agent-loops"], "high")]
    })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockMerge).not.toHaveBeenCalled()
    expect(getQueue()).toHaveLength(0)
    expect(record).toMatchObject({ skipReason: "ingest-busy", mergesEnqueued: 0 })
    // Withheld merges are not a run: the job stays due and scans again,
    // and the withheld group is kept for the Maintenance screen meanwhile.
    expect((await loadScheduledMaintenanceConfig(tmp.path)).lastRun).toBeNull()
    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([group(["agent-loop", "agent-loops"], "high")])
  })

  it("stops between groups when an ingest starts, and still reports the merge already queued", async () => {
    await setConfig(null)
    await writeFileRaw(`${tmp.path}/wiki/concepts/hook-a.md`, page("Hook", "2026-09-01", ["c.md"]))
    await writeFileRaw(`${tmp.path}/wiki/concepts/hook-b.md`, page("Hooks", "2026-10-01", ["d.md"]))
    // Reads: 1 at the start, 2 before the first merge, 3 before the second.
    ingestSummary.busyFromRead = 3
    mockDetect.mockResolvedValue([
      group(["agent-loop", "agent-loops"], "high"),
      group(["hook-a", "hook-b"], "high"),
    ])
    mockMerge.mockResolvedValue({ canonicalPath: "", canonicalContent: "", rewrites: [], pagesToDelete: [], backup: [] })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockMerge.mock.calls.map((c) => c[2])).toEqual(["agent-loops"])
    expect(record).toMatchObject({
      skipReason: "ingest-busy",
      mergesEnqueued: 1,
      mergesDone: 1,
      mergesFailed: 0,
    })
  })

  it("withholds merges when the job is switched off while the scan runs", async () => {
    await setConfig(null)
    mockDetect.mockImplementation(async () => {
      await saveScheduledMaintenanceConfig(tmp.path, { enabled: false, intervalHours: 24, lastRun: null })
      return [group(["agent-loop", "agent-loops"], "high")]
    })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockMerge).not.toHaveBeenCalled()
    expect(record).toMatchObject({ skipReason: "switched-off", mergesEnqueued: 0 })
  })

  it("merges nothing when the not-duplicates list cannot be read", async () => {
    await setConfig(null)
    await writeFileRaw(`${tmp.path}/.llm-wiki/dedup-not-duplicates.json`, "[[\"agent-loop\", \"agent-loo")
    mockDetect.mockResolvedValue([group(["agent-loop", "agent-loops"], "high")])

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockMerge).not.toHaveBeenCalled()
    expect(getQueue()).toHaveLength(0)
    expect(record?.error).toMatch(/not-duplicates/)
    // Every group found is kept for a decision by hand.
    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([group(["agent-loop", "agent-loops"], "high")])
  })
})

describe("scheduled maintenance tick – hub rebuild", () => {
  const HUB = "wiki/concepts/agent-harness-engineering.md"
  const SECOND_HUB = "wiki/concepts/loop-engineering.md"
  const REQUEST = ".llm-wiki/hub-rebuild-request.json"
  /** The live Agent Harness Wiki vault's hub page, copied on 5 Oct 2026. */
  const HUB_PAGE = [
    "---",
    "type: concept",
    "title: Agent Harness Engineering",
    "created: 2026-09-30",
    "updated: 2026-09-30",
    "tags: [agent-architecture, execution-environment]",
    "related: [learn-agent-arch-ext-addyosmani-loop-engineering, loop-engineering]",
    'sources: ["learn-agent-arch-ext-addyosmani-loop-engineering.md"]',
    "---",
    "# Agent Harness Engineering",
    "",
    "Agent harness engineering means designing the environment in which an individual agent operates.",
    "",
    "[[Learn-agent-arch-ext-addyosmani-loop-engineering]] uses this idea to distinguish two levels of design. The harness supports an individual agent. [[Loop-engineering]] coordinates recurring discovery, delegation, verification, and state recording around agent runs.",
    "",
    "The article links to a separate essay on harness engineering but does not develop its implementation here. This source therefore supports the distinction between levels, not a detailed specification of a harness.",
    "",
  ].join("\n")

  function summary(title: string, rawSource: string, body: string): string {
    return [
      "---",
      "type: source",
      `title: ${title}`,
      "created: 2026-09-29",
      "updated: 2026-09-29",
      "tags: [agents]",
      "related: []",
      `sources: [${JSON.stringify(rawSource)}]`,
      "---",
      `# ${title}`,
      "",
      body,
      "",
    ].join("\n")
  }

  /** A model reply: a whole page whose body is the old one plus `extra`. */
  function rewrite(extra: string, title = "Agent Harness Engineering (rebuilt)"): string {
    const oldBody = HUB_PAGE.split("---\n").slice(2).join("---\n")
    return ["---", "type: concept", `title: ${title}`, "sources: []", "---", oldBody, extra, ""].join("\n")
  }

  async function archives(): Promise<Record<string, unknown>[]> {
    const dir = `${tmp.path}/.llm-wiki/hub-rebuild-archive`
    if (!(await realFs.fileExists(dir))) return []
    const files = (await realFs.listDirectory(dir)).filter((f) => !f.is_dir)
    return Promise.all(files.map(async (f) => JSON.parse(await readFileRaw(f.path))))
  }

  async function pageHistory(): Promise<string[]> {
    const dir = `${tmp.path}/.llm-wiki/page-history`
    if (!(await realFs.fileExists(dir))) return []
    const walk = (nodes: Awaited<ReturnType<typeof realFs.listDirectory>>): string[] =>
      nodes.flatMap((n) => (n.is_dir ? walk(n.children ?? []) : [n.path]))
    return Promise.all(walk(await realFs.listDirectory(dir)).map(readFileRaw))
  }

  async function writeRequest(pages: string[]): Promise<void> {
    await writeFileRaw(`${tmp.path}/${REQUEST}`, JSON.stringify({ pages }))
  }

  beforeEach(async () => {
    await setConfig(null)
    await writeFileRaw(`${tmp.path}/${HUB}`, HUB_PAGE)
    await writeFileRaw(
      `${tmp.path}/wiki/sources/learn-agent-arch-ext-addyosmani-loop-engineering.md`,
      summary("Loop Engineering", "learn-agent-arch-ext-addyosmani-loop-engineering.md", "Loop engineering wraps agent runs."),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/sources/harness-notes.md`,
      summary("Harness Notes", "harness-notes.md", "A harness holds the tools, hooks and permissions an agent runs with."),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/sources/codex-howto-catalog.md`,
      summary("Codex How-To Repository Catalog", "codex-howto-CATALOG.md", "A table of contents."),
    )
    await writeFileRaw(`${tmp.path}/wiki/concepts/loop-engineering.md`, page("Loop Engineering", "2026-09-30", ["x.md"]))
    mockSearch.mockResolvedValue([
      { id: "sources/learn-agent-arch-ext-addyosmani-loop-engineering", score: 0.9 },
      { id: "concepts/loop-engineering", score: 0.85 },
      { id: "sources/harness-notes", score: 0.8 },
      { id: "sources/codex-howto-catalog", score: 0.5 },
    ])
  })

  it("rewrites a requested hub from its source summaries, unions its sources, backs it up and archives the request", async () => {
    await writeRequest([HUB])
    mockModel.mockResolvedValue(
      rewrite(
        "A harness holds the tools, hooks and permissions an agent runs with ([[sources/harness-notes|Harness Notes]]); loop engineering wraps those runs ([[Learn-agent-arch-ext-addyosmani-loop-engineering]]).",
      ),
    )

    const record = await runMaintenanceTick(project, { now: () => T0 })

    // The search used the hub's title and text.
    const query = String(mockSearch.mock.calls[0][1])
    expect(query).toContain("Agent Harness Engineering")
    expect(query).toContain("designing the environment in which an individual agent operates")
    // The model got the hub and every source summary found, and no other page.
    const [, user] = mockModel.mock.calls[0]
    expect(user).toContain("designing the environment in which an individual agent operates")
    expect(user).toContain("wiki/sources/harness-notes.md")
    expect(user).toContain("A harness holds the tools, hooks and permissions an agent runs with.")
    expect(user).toContain("wiki/sources/learn-agent-arch-ext-addyosmani-loop-engineering.md")
    expect(user).toContain("wiki/sources/codex-howto-catalog.md")
    expect(user).not.toContain("Loop Engineering body.")

    const rebuilt = await readFileRaw(`${tmp.path}/${HUB}`)
    expect(rebuilt).toContain("[[sources/harness-notes|Harness Notes]]")
    // The hub keeps its own front matter: title, type and created hold.
    expect(rebuilt).toMatch(/^---\ntype: concept\ntitle: Agent Harness Engineering\ncreated: 2026-09-30\n/)
    expect(rebuilt).toContain("updated: 2026-10-05")
    // Its own source plus each linked summary's; the unlinked catalog is not drawn on.
    expect(rebuilt).toContain(
      'sources: ["learn-agent-arch-ext-addyosmani-loop-engineering.md", "harness-notes.md"]',
    )
    expect(await pageHistory()).toEqual([HUB_PAGE])

    expect(await realFs.fileExists(`${tmp.path}/${REQUEST}`)).toBe(false)
    expect(await archives()).toEqual([
      expect.objectContaining({ pages: [HUB], results: [{ path: HUB, result: "rebuilt" }] }),
    ])
    expect(record).toMatchObject({ skipReason: null, hubsRebuilt: [HUB], hubsRejected: [] })
    expect((await runRecords()).slice(-1)[0]).toMatchObject({ hubsRebuilt: [HUB], hubsRejected: [] })
  })

  it("rejects a rewrite whose body shrinks below the same-path merge's ratio, and one with no front matter, keeping the old page", async () => {
    await writeFileRaw(`${tmp.path}/${SECOND_HUB}`, page("Loop Engineering", "2026-09-30", ["x.md"]))
    await writeRequest([HUB, SECOND_HUB])
    mockModel
      .mockResolvedValueOnce("---\ntype: concept\ntitle: Agent Harness Engineering\n---\n# Agent Harness Engineering\n\nShort.\n")
      .mockResolvedValueOnce("# Loop Engineering\n\nLoop Engineering body, rewritten at length with no front matter at all.\n")

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(await readFileRaw(`${tmp.path}/${HUB}`)).toBe(HUB_PAGE)
    expect(await readFileRaw(`${tmp.path}/${SECOND_HUB}`)).toBe(page("Loop Engineering", "2026-09-30", ["x.md"]))
    const [archive] = await archives()
    expect(archive.results).toEqual([
      { path: HUB, result: "rejected", reason: expect.stringMatching(/shrank/) },
      { path: SECOND_HUB, result: "rejected", reason: expect.stringMatching(/front matter/) },
    ])
    expect(record).toMatchObject({ hubsRebuilt: [], hubsRejected: [HUB, SECOND_HUB] })
  })

  it("counts a summary as drawn on for each live link form, and not for a link to another folder", async () => {
    // Slugs from the live vault; the dotted-slug alias and folder link forms are
    // the live ones, and the `wiki/sources/<slug>.md` form is made up to pin the stripping.
    await writeFileRaw(
      `${tmp.path}/wiki/sources/learn-agent-arch-ext-arxiv-1705.08500-selective-classification.md`,
      summary("Selective Classification", "learn-agent-arch-ext-arxiv-1705.08500-selective-classification.md", "Abstain when unsure."),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/sources/openclaw-docs-platforms--platforms-overview.md`,
      summary("Platforms Overview", "openclaw-docs-platforms--platforms-overview.md", "Where the gateway runs."),
    )
    mockSearch.mockResolvedValue([
      { id: "sources/learn-agent-arch-ext-arxiv-1705.08500-selective-classification", score: 0.9 },
      { id: "sources/openclaw-docs-platforms--platforms-overview", score: 0.85 },
      { id: "sources/harness-notes", score: 0.8 },
    ])
    await writeRequest([HUB])
    mockModel.mockResolvedValue(
      rewrite(
        [
          "An agent may abstain ([[learn-agent-arch-ext-arxiv-1705.08500-selective-classification|Selective classification]]).",
          "The gateway runs on several platforms ([[wiki/sources/openclaw-docs-platforms--platforms-overview.md|Platforms]]).",
          "See also [[concepts/harness-notes]].",
        ].join(" "),
      ),
    )

    await runMaintenanceTick(project, { now: () => T0 })

    expect(await readFileRaw(`${tmp.path}/${HUB}`)).toContain(
      'sources: ["learn-agent-arch-ext-addyosmani-loop-engineering.md", "learn-agent-arch-ext-arxiv-1705.08500-selective-classification.md", "openclaw-docs-platforms--platforms-overview.md"]',
    )
  })

  it("fails a hub with no front matter on disk, one the search finds no summaries for, and a path outside wiki/", async () => {
    await writeFileRaw(`${tmp.path}/wiki/concepts/bare.md`, "# Bare\n\nNo front matter here.\n")
    await writeFileRaw(`${tmp.path}/raw/outside.md`, HUB_PAGE)
    await writeRequest(["wiki/concepts/bare.md", HUB, "raw/outside.md", "wiki/../raw/outside.md", "wiki/..\\raw\\outside.md"])
    // The first search (for the hub) finds only a concept page.
    mockSearch.mockResolvedValueOnce([{ id: "concepts/loop-engineering", score: 0.9 }])

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockModel).not.toHaveBeenCalled()
    expect(await readFileRaw(`${tmp.path}/raw/outside.md`)).toBe(HUB_PAGE)
    const [archive] = await archives()
    expect(archive.results).toEqual([
      { path: "wiki/concepts/bare.md", result: "failed", reason: "the page has no front matter" },
      { path: HUB, result: "failed", reason: "the search found no source summaries" },
      { path: "raw/outside.md", result: "failed", reason: "not a wiki page path" },
      { path: "wiki/../raw/outside.md", result: "failed", reason: "not a wiki page path" },
      { path: "wiki/..\\raw\\outside.md", result: "failed", reason: "not a wiki page path" },
    ])
    expect(record).toMatchObject({ hubsRebuilt: [], hubsRejected: [] })
  })

  it("does nothing for hubs when no request file is present", async () => {
    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockSearch).not.toHaveBeenCalled()
    expect(mockModel).not.toHaveBeenCalled()
    expect(await archives()).toEqual([])
    expect(await readFileRaw(`${tmp.path}/${HUB}`)).toBe(HUB_PAGE)
    expect(record).toMatchObject({ skipReason: null })
    expect(record).not.toHaveProperty("hubsRebuilt")
  })

  it("records a hub whose search fails as failed with the reason, and carries on with the next", async () => {
    await writeFileRaw(`${tmp.path}/${SECOND_HUB}`, page("Loop Engineering", "2026-09-30", ["x.md"]))
    await writeRequest([HUB, SECOND_HUB])
    // searchByEmbedding answers a failed embedding fetch with no hits.
    mockSearch.mockResolvedValueOnce([])
    mockEmbeddingError.mockReturnValueOnce("Embedding API 503: upstream unavailable")
    mockModel.mockResolvedValue(rewrite("Loop engineering wraps agent runs ([[learn-agent-arch-ext-addyosmani-loop-engineering]]).", "Loop Engineering"))

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(await readFileRaw(`${tmp.path}/${HUB}`)).toBe(HUB_PAGE)
    expect(await readFileRaw(`${tmp.path}/${SECOND_HUB}`)).toContain("updated: 2026-10-05")
    const [archive] = await archives()
    expect(archive.results).toEqual([
      { path: HUB, result: "failed", reason: expect.stringContaining("Embedding API 503") },
      { path: SECOND_HUB, result: "rebuilt" },
    ])
    expect(record).toMatchObject({ hubsRebuilt: [SECOND_HUB], hubsRejected: [] })
  })

  it("records every hub as failed when embeddings are off, and a hub that is not on disk", async () => {
    await writeRequest([HUB, "wiki/concepts/merged-away.md"])
    useWikiStore.getState().setEmbeddingConfig({ enabled: false, endpoint: "", apiKey: "", model: "" })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockSearch).not.toHaveBeenCalled()
    expect(mockModel).not.toHaveBeenCalled()
    const [archive] = await archives()
    expect(archive.results).toEqual([
      { path: HUB, result: "failed", reason: expect.stringMatching(/embeddings are off/) },
      { path: "wiki/concepts/merged-away.md", result: "failed", reason: expect.stringMatching(/not found/) },
    ])
    expect(record).toMatchObject({ skipReason: null, hubsRebuilt: [], hubsRejected: [] })
  })

  it("offers source summaries only within the text budget", async () => {
    useWikiStore.getState().setLlmConfig({ ...useWikiStore.getState().llmConfig, maxContextSize: 10_000 })
    for (const name of ["long-a", "long-b", "long-c"]) {
      await writeFileRaw(`${tmp.path}/wiki/sources/${name}.md`, summary(name, `${name}.md`, `${name} `.repeat(400)))
    }
    mockSearch.mockResolvedValue([
      { id: "sources/long-a", score: 0.9 },
      { id: "sources/long-b", score: 0.8 },
      { id: "sources/long-c", score: 0.7 },
    ])
    await writeRequest([HUB])
    mockModel.mockResolvedValue(rewrite("More."))

    await runMaintenanceTick(project, { now: () => T0 })

    const [, user] = mockModel.mock.calls[0]
    expect(user).toContain("wiki/sources/long-a.md")
    expect(user).toContain("wiki/sources/long-b.md")
    expect(user).not.toContain("wiki/sources/long-c.md")
    // Page budget 5,000 characters, less the hub, for every summary together.
    expect(user.length).toBeLessThan(5_000 + HUB_PAGE.length + 2_000)
  })

  it("leaves an unreadable request in place and records why", async () => {
    await writeFileRaw(`${tmp.path}/${REQUEST}`, '{"pages": ["wiki/concepts/agent-harness-engin')

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockModel).not.toHaveBeenCalled()
    expect(await realFs.fileExists(`${tmp.path}/${REQUEST}`)).toBe(true)
    expect(await archives()).toEqual([])
    expect(record?.error).toMatch(/hub-rebuild request/)
  })

  it("keeps a hub that changed on disk during the model call, and records it as failed", async () => {
    await writeRequest([HUB])
    const ingested = `${HUB_PAGE}\nA paragraph an ingest added while the model was working.\n`
    mockModel.mockImplementation(async () => {
      await writeFileRaw(`${tmp.path}/${HUB}`, ingested)
      return rewrite("More.")
    })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(await readFileRaw(`${tmp.path}/${HUB}`)).toBe(ingested)
    const [archive] = await archives()
    expect(archive.results).toEqual([
      { path: HUB, result: "failed", reason: "the page changed during the rebuild" },
    ])
    expect(record).toMatchObject({ hubsRebuilt: [], hubsRejected: [] })
  })

  it("does not start the rebuild when an ingest started during the duplicate scan", async () => {
    await writeRequest([HUB])
    mockDetect.mockImplementation(async () => {
      ingestSummary.pending = 1
      return []
    })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(mockModel).not.toHaveBeenCalled()
    expect(await realFs.fileExists(`${tmp.path}/${REQUEST}`)).toBe(true)
    expect(record).toMatchObject({ skipReason: "ingest-busy" })
  })

  it("leaves a request with no list of page paths in place and records why", async () => {
    for (const body of ['{"hubs": []}', '{"pages": ["wiki/concepts/a.md", 7]}']) {
      await writeFileRaw(`${tmp.path}/${REQUEST}`, body)
      await setConfig(null)

      const record = await runMaintenanceTick(project, { now: () => T0 })

      expect(record?.error).toMatch(/no "pages" list of page paths/)
      expect(await readFileRaw(`${tmp.path}/${REQUEST}`)).toBe(body)
    }
    expect(mockModel).not.toHaveBeenCalled()
    expect(await archives()).toEqual([])
  })

  it("withholds the hub write when an ingest starts during the model call, and the request and the run stay due", async () => {
    await writeRequest([HUB])
    mockModel.mockImplementation(async () => {
      ingestSummary.pending = 1
      return rewrite("More.")
    })

    const record = await runMaintenanceTick(project, { now: () => T0 })

    expect(await readFileRaw(`${tmp.path}/${HUB}`)).toBe(HUB_PAGE)
    expect(await realFs.fileExists(`${tmp.path}/${REQUEST}`)).toBe(true)
    expect(await archives()).toEqual([])
    expect(record).toMatchObject({ skipReason: "ingest-busy" })
    expect((await loadScheduledMaintenanceConfig(tmp.path)).lastRun).toBeNull()
  })
})
