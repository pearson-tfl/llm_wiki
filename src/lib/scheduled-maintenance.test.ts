/**
 * Seam 2 of #16 (ticket #18): the scheduled maintenance tick, called with
 * an explicit clock against a real temporary project. Detection and merge
 * are faked at the dedup runner boundary; the merge queue, the
 * not-duplicates list, the saved-groups file, the run record and the
 * review sweep are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createDeferred, waitFor } from "@/test-helpers/deferred"

const storage = vi.hoisted(() => new Map<string, unknown>())
const ingestSummary = vi.hoisted(() => ({ pending: 0, processing: 0 }))

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
}))

vi.mock("@/lib/ingest-queue", () => ({
  getQueueSummary: () => ({ ...ingestSummary }),
}))

import { executeMerge, runDuplicateDetection } from "@/lib/dedup-runner"
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
import type { DuplicateGroup } from "./dedup"
import type { WikiProject } from "@/types/wiki"

const mockDetect = vi.mocked(runDuplicateDetection)
const mockMerge = vi.mocked(executeMerge)

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
  mockDetect.mockReset()
  mockMerge.mockReset()
  mockDetect.mockResolvedValue([])

  useWikiStore.getState().setProject(project)
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
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
  })
})
