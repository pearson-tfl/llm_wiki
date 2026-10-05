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
import { addNotDuplicate } from "@/lib/dedup-storage"
import {
  loadScheduledMaintenanceConfig,
  saveScheduledMaintenanceConfig,
} from "@/lib/project-store"
import {
  loadPendingDuplicateGroups,
  runMaintenanceTick,
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
