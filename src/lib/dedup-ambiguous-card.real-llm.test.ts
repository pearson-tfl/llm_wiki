/**
 * A Maintenance-screen merge of a group whose slug two pages share (#126),
 * on a copy of a real vault: the real executeMerge refuses the slug, and
 * the card's merge, the real enqueueCardMerge with the real merge queue
 * and saved groups, refuses it in the same words with no task queued. The
 * merge's refusal comes before its model call, so no model is called.
 * And the scheduled run's page list names the copy's pages as the merge's
 * page read does, the project path ending in a slash or not.
 * Files go through node:fs; only the project registry is replaced.
 *
 * Gated behind RUN_LLM_TESTS=1 and DEDUP_VAULT_COPY, the path of the copy,
 * which must hold a concept and an entity page of one slug. Never point it
 * at a live vault: the test saves a group to the copy's saved groups.
 */
import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs } from "@/test-helpers/fs-temp"
import { useWikiStore } from "@/stores/wiki-store"
import type { DuplicateGroup } from "./dedup"

const ENABLED = process.env.RUN_LLM_TESTS === "1" && !!process.env.DEDUP_VAULT_COPY
const PROJECT_ID = "ambiguous-card-vault-copy"
const vault = path.resolve(process.env.DEDUP_VAULT_COPY ?? "")

vi.mock("@/commands/fs", () => realFs)
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async () => vault),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

describe.skipIf(!ENABLED)("a card merge of a shared slug on a vault copy (#126)", () => {
  it("is refused before queueing, in the merge's own words", async () => {
    const { executeMerge } = await import("./dedup-runner")
    const { enqueueCardMerge, getQueue, restoreQueue } = await import("./dedup-queue")
    const { listWikiPages, loadPendingDuplicateGroups, savePendingDuplicateGroups } = await import("./dedup-storage")
    const { pagesNamed } = await import("./dedup")

    const pages = await listWikiPages(vault)
    const concepts = (await fs.readdir(`${vault}/wiki/concepts`)).map((f) => f.replace(/\.md$/, ""))
    const shared = concepts.find((slug) => pagesNamed(pages, slug).length === 2)
    const single = concepts.find((slug) => pagesNamed(pages, slug).length === 1)
    expect(shared, "the copy holds a concept and an entity page of one slug").toBeDefined()
    expect(single, "the copy holds a concept page whose slug no other page has").toBeDefined()
    const group: DuplicateGroup = {
      slugs: [shared!, single!],
      confidence: "high",
      reason: "live check, #126",
    }
    useWikiStore.getState().setLlmConfig({
      provider: "openai",
      apiKey: "unused",
      model: "unused",
      ollamaUrl: "",
      customEndpoint: "http://127.0.0.1:9/never-called",
      maxContextSize: 128000,
    })

    const mergeRefusal = await executeMerge(vault, group, single!, useWikiStore.getState().llmConfig)
      .then(() => "merged", (err: Error) => err.message)

    const saved = await loadPendingDuplicateGroups(vault)
    await savePendingDuplicateGroups(vault, [...saved, group])
    await restoreQueue(PROJECT_ID, vault)
    const cardRefusal = await enqueueCardMerge(PROJECT_ID, vault, group, single!)

    console.log(JSON.stringify({ group: group.slugs, mergeRefusal, cardRefusal, queued: getQueue().length }))
    expect(mergeRefusal).toBe(`Slug "${shared}" names 2 pages: concepts/${shared}, entities/${shared}`)
    expect(cardRefusal).toBe(mergeRefusal)
    expect(getQueue()).toEqual([])
    expect(await loadPendingDuplicateGroups(vault)).toEqual([...saved, group])
  })

  it("lists the copy's pages as the merge reads them, with or without a trailing slash", async () => {
    const { loadAllWikiPages } = await import("./dedup-runner")
    const { listWikiPages } = await import("./dedup-storage")

    for (const pp of [vault, `${vault}/`]) {
      const listed = (await listWikiPages(pp)).map((p) => p.path).filter((p) => p.endsWith(".md")).sort()
      const read = (await loadAllWikiPages(pp)).map((p) => p.path).sort()
      console.log(JSON.stringify({ pp, listed: listed.length, read: read.length, first: listed[0] }))
      expect(listed).toEqual(read)
    }
  })
})
