/**
 * #126: a merge asked for on a Maintenance-screen card whose slug names
 * more than one page is refused before any task is queued. Runs the real
 * merge queue and the saved groups against a real temporary project; only
 * the merge and its re-embed are replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { waitFor } from "@/test-helpers/deferred"

const project = vi.hoisted(() => ({ path: "" }))

vi.mock("@/commands/fs", () => realFs)
vi.mock("./dedup-runner", () => ({
  executeMerge: vi.fn(),
  reembedMergedPages: vi.fn(),
}))
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async () => project.path),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

import { clearQueueState, enqueueCardMerge, getQueue, restoreQueue } from "./dedup-queue"
import { executeMerge } from "./dedup-runner"
import { loadPendingDuplicateGroups, savePendingDuplicateGroups } from "./dedup-storage"
import { __resetProjectLocksForTesting } from "./project-mutex"
import { useWikiStore } from "@/stores/wiki-store"
import type { DuplicateGroup } from "./dedup"

const PROJECT_ID = "card-merge-project"
const mockExecuteMerge = vi.mocked(executeMerge)

let tmp: { path: string; cleanup: () => Promise<void> }

function group(slugs: string[]): DuplicateGroup {
  return { slugs, confidence: "high", reason: "same topic" }
}

beforeEach(async () => {
  tmp = await createTempProject("dedup-queue-card-merge")
  project.path = tmp.path
  clearQueueState()
  __resetProjectLocksForTesting()
  mockExecuteMerge.mockReset()
  mockExecuteMerge.mockResolvedValue({
    canonicalContent: "",
    canonicalPath: "",
    rewrites: [],
    pagesToDelete: [],
    backup: [],
  })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })
  for (const page of [
    "wiki/concepts/agent-skills.md",
    "wiki/entities/agent-skills.md",
    "wiki/entities/skills.md",
    "wiki/concepts/seat.md",
  ]) {
    await writeFileRaw(`${tmp.path}/${page}`, "# page\n")
  }
  await restoreQueue(PROJECT_ID, tmp.path)
})

afterEach(async () => {
  clearQueueState()
  await tmp.cleanup()
})

describe("enqueueCardMerge", () => {
  it("refuses a group whose slug names two pages, naming them, with no task queued and the saved group kept (#126)", async () => {
    const ambiguous = group(["agent-skills", "skills"])
    await savePendingDuplicateGroups(tmp.path, [ambiguous])

    const refusal = await enqueueCardMerge(PROJECT_ID, tmp.path, ambiguous, "skills")

    expect(refusal).toBe('Slug "agent-skills" names 2 pages: concepts/agent-skills, entities/agent-skills')
    expect(getQueue()).toEqual([])
    expect(mockExecuteMerge).not.toHaveBeenCalled()
    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([ambiguous])
  })

  it("queues a group whose names each name one page and drops its saved group", async () => {
    const byPageId = group(["concepts/agent-skills", "skills"])
    const other = group(["seat", "lane"])
    await savePendingDuplicateGroups(tmp.path, [byPageId, other])

    const refusal = await enqueueCardMerge(PROJECT_ID, tmp.path, byPageId, "skills")

    expect(refusal).toBeNull()
    await waitFor(() => mockExecuteMerge.mock.calls.length === 1)
    expect(mockExecuteMerge.mock.calls[0].slice(1, 3)).toEqual([byPageId, "skills"])
    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([other])
  })
})
