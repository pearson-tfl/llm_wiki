/**
 * Seam 2 of #16 (ticket #18): the scheduled maintenance tick, called with
 * an explicit clock against a real temporary project. Detection and merge
 * are faked at the dedup runner boundary; the merge queue, the
 * not-duplicates list, the saved-groups file, the run record and the
 * review sweep are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { waitFor } from "@/test-helpers/deferred"

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
