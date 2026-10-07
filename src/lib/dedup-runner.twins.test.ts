/**
 * #109: merging pages that share a slug. Runs the real `executeMerge`
 * against a real temporary project shaped like the Agent Harness Wiki
 * vault's pairs: a concept and an entity page named `agent-skills`, linked
 * from other pages only as `[[agent-skills]]`. The model's reply is faked
 * at `streamChat`; the Tauri vector-store commands are an in-memory store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeVectorStore> | null }))
const model = vi.hoisted(() => ({ reply: "", prompts: [] as string[] }))
const written = vi.hoisted(() => ({ paths: [] as string[] }))

vi.mock("@/commands/fs", () => ({
  ...realFs,
  writeFile: async (path: string, contents: string) => {
    written.paths.push(path)
    await realFs.writeFile(path, contents)
  },
}))
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => store.current!.invoke(cmd, args),
}))
vi.mock("./llm-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llm-client")>()),
  streamChat: vi.fn(async (_cfg: unknown, messages: { content: string }[], callbacks: {
    onToken: (t: string) => void
    onDone: (c?: { truncated?: boolean }) => void
  }) => {
    model.prompts.push(messages[1].content)
    callbacks.onToken(model.reply)
    callbacks.onDone({})
  }),
}))

import { executeMerge } from "./dedup-runner"
import type { LlmConfig } from "@/stores/wiki-store"

const llmConfig = { provider: "ollama", apiKey: "", model: "qwen3:8b", ollamaUrl: "", customEndpoint: "", maxContextSize: 32000 } as LlmConfig
const TWINS = { slugs: ["concepts/agent-skills", "entities/agent-skills"], reason: "same slug", confidence: "high" as const }

/** Front matter shaped like the live vault's pages. */
function page(type: string, related: string[], body: string): string {
  return ["---", `type: ${type}`, "title: Agent Skills", `related: [${related.join(", ")}]`, "---", body, ""].join("\n")
}

const CONCEPT_BODY = "# Agent Skills\n\nProgressive disclosure loads the description first."
const ENTITY_BODY = "# Agent Skills\n\nAn open standard for packaging reusable agent expertise."
const LINKER = page("entity", ["agent-skills"], "# Claude Code\n\nLoads [[agent-skills]] from `.claude/skills/`.")
const INDEX = [
  "# Index",
  "- [Agent Skills](concepts/agent-skills.md)",
  "- [Agent Skills](entities/agent-skills.md)",
  "- [Claude Code](entities/claude-code.md)",
  "",
].join("\n")

let tmp: { path: string; cleanup: () => Promise<void> }
const at = (rel: string) => `${tmp.path}/${rel}`

beforeEach(async () => {
  tmp = await createTempProject("merge-twins")
  store.current = createFakeVectorStore()
  model.prompts = []
  written.paths = []
  await writeFileRaw(at("wiki/concepts/agent-skills.md"), page("concept", ["instruction-pointers"], CONCEPT_BODY))
  await writeFileRaw(at("wiki/entities/agent-skills.md"), page("entity", ["claude-code"], ENTITY_BODY))
  await writeFileRaw(at("wiki/entities/claude-code.md"), LINKER)
  await writeFileRaw(at("wiki/entities/echo-loop.md"), page("entity", [], "# Echo loop"))
  await writeFileRaw(at("wiki/index.md"), INDEX)
  model.reply = page("entity", [], `${ENTITY_BODY}\n\nProgressive disclosure loads the description first.`)
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("executeMerge – pages sharing a slug (#109)", () => {
  it("finds each page by its path, keeps the chosen one with the other folded in, and deletes the other", async () => {
    const result = await executeMerge(tmp.path, TWINS, "entities/agent-skills", llmConfig)

    expect(model.prompts[0]).toContain(CONCEPT_BODY)
    expect(model.prompts[0]).toContain(ENTITY_BODY)
    const kept = await readFileRaw(at("wiki/entities/agent-skills.md"))
    expect(kept).toContain("An open standard for packaging reusable agent expertise.")
    expect(kept).toContain("Progressive disclosure loads the description first.")
    expect(kept).toMatch(/related: \[.*claude-code.*instruction-pointers|related: \[.*instruction-pointers.*claude-code/)
    expect(await fileExists(at("wiki/concepts/agent-skills.md"))).toBe(false)
    expect(result.pagesToDelete).toEqual(["wiki/concepts/agent-skills.md"])
  })

  it("leaves the bare links alone, since they still name the kept page, and drops only the removed page's index line", async () => {
    await executeMerge(tmp.path, TWINS, "entities/agent-skills", llmConfig)

    expect(await readFileRaw(at("wiki/entities/claude-code.md"))).toBe(LINKER)
    expect(await readFileRaw(at("wiki/index.md"))).toBe(INDEX.replace("- [Agent Skills](concepts/agent-skills.md)\n", ""))
  })

  it("sends bare links to a page merged across two slugs to the kept page, and drops its bare index line (#139)", async () => {
    const echoLinker = page("entity", ["echo-loop"], "# Hermes\n\nRuns an [[echo-loop]] beside [[agent-skills]].")
    await writeFileRaw(at("wiki/entities/hermes.md"), echoLinker)
    await writeFileRaw(at("wiki/index.md"), `${INDEX}- [[echo-loop]]\n`)
    const judged = { slugs: ["concepts/agent-skills", "entities/echo-loop"], reason: "Judged one topic", confidence: "high" as const }

    const result = await executeMerge(tmp.path, judged, "concepts/agent-skills", llmConfig)

    expect(result.pagesToDelete).toEqual(["wiki/entities/echo-loop.md"])
    expect(await readFileRaw(at("wiki/entities/hermes.md"))).toBe(
      page("entity", ['"concepts/agent-skills"'], "# Hermes\n\nRuns an [[concepts/agent-skills]] beside [[agent-skills]]."),
    )
    expect(await readFileRaw(at("wiki/entities/claude-code.md"))).toBe(LINKER)
    expect(await readFileRaw(at("wiki/index.md"))).toBe(INDEX)
  })

  it("refuses a group that names one page twice, before any model call or write", async () => {
    const twice = { slugs: ["echo-loop", "echo-loop"], reason: "same page twice", confidence: "high" as const }

    await expect(executeMerge(tmp.path, twice, "echo-loop", llmConfig)).rejects.toThrow(/at least 2 pages/)
    expect(model.prompts).toEqual([])
    expect(written.paths).toEqual([])
  })

  it("refuses a group that names one page by its page id and by its slug, before any model call or write", async () => {
    const twice = { slugs: ["entities/echo-loop", "echo-loop"], reason: "same page twice", confidence: "high" as const }

    await expect(executeMerge(tmp.path, twice, "echo-loop", llmConfig)).rejects.toThrow()
    expect(model.prompts).toEqual([])
    expect(written.paths).toEqual([])
    expect(await fileExists(at("wiki/entities/echo-loop.md"))).toBe(true)
  })

  it("finds a bare slug among the entity and concept pages only, not a page of another folder with that name", async () => {
    await writeFileRaw(at("wiki/comparisons/echo-loop.md"), page("comparison", [], "# Echo loop comparison"))
    const group = { slugs: ["echo-loop", "claude-code"], reason: "model's group", confidence: "high" as const }

    const result = await executeMerge(tmp.path, group, "claude-code", llmConfig)

    expect(model.prompts[0]).toContain("# Echo loop\n")
    expect(model.prompts[0]).not.toContain("# Echo loop comparison")
    expect(result.pagesToDelete).toEqual(["wiki/entities/echo-loop.md"])
    expect(await fileExists(at("wiki/comparisons/echo-loop.md"))).toBe(true)
  })

  it("refuses a page id that names no page, before any model call or write", async () => {
    const missing = { slugs: ["concepts/no-such-page", "echo-loop"], reason: "stale group", confidence: "medium" as const }

    await expect(executeMerge(tmp.path, missing, "echo-loop", llmConfig))
      .rejects.toThrow('Slug "concepts/no-such-page" not found on disk')
    expect(model.prompts).toEqual([])
    expect(written.paths).toEqual([])
  })

  it("refuses a bare slug that names two pages, rather than merging whichever was read last", async () => {
    const ambiguous = { slugs: ["agent-skills", "echo-loop"], reason: "model's group", confidence: "low" as const }

    await expect(executeMerge(tmp.path, ambiguous, "echo-loop", llmConfig))
      .rejects.toThrow('Slug "agent-skills" names 2 pages: concepts/agent-skills, entities/agent-skills')
    expect(model.prompts).toEqual([])
    expect(written.paths).toEqual([])
  })
})
