import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { resetEmbeddingOptimizeAccountingForTests } from "./embedding"

vi.mock("@/commands/fs", () => realFs)

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

// The embedding search runs for real; the Tauri commands under it are faked.
// A query's vector is its position in `searchQueries`, and the vector store
// answers it with one chunk per page listed for that query in `searchHits`.
let searchHits: Record<string, Array<{ id: string; score: number }>> = {}
const searchQueries: string[] = []

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>()
  return {
    ...actual,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "embedding_fetch") {
        searchQueries.push(String(args?.text))
        return [searchQueries.length - 1]
      }
      if (cmd === "vector_search_chunks") {
        const query = searchQueries[(args?.queryEmbedding as number[])[0]]
        return (searchHits[query] ?? []).map((hit) => ({
          chunk_id: `${hit.id}#0`,
          page_id: hit.id,
          chunk_index: 0,
          chunk_text: "",
          heading_path: "",
          score: hit.score,
        }))
      }
      return actual.invoke(cmd, args)
    },
  }
})

vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding")>()
  return { ...actual, embedPage: vi.fn(async () => {}) }
})

// The model fake routes on the system prompt. A merge appends the existing
// body to the incoming file unless `mergeReply` replaces the whole reply.
let analysisError: string | null = null
let generationReply = ""
let mergeReply: string | null = null

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const system = String(messages?.[0]?.content ?? "")
    const user = String(messages?.[1]?.content ?? "")
    if (system.startsWith("You are merging source-backed material")) {
      if (mergeReply !== null) {
        cb.onToken(mergeReply)
      } else {
        const [previous = "", additional = ""] = user.split(/\n\n---\n\n## Additional material[^\n]*\n\n/)
        const existing = previous.replace(/^## Previously collected material[^\n]*\n\n/, "")
        const incoming = additional.split("\n\n---\n\nNow output the merged file")[0]
        cb.onToken(`${incoming.trim()}\n\n${existing.replace(/^---\n[\s\S]*?\n---\n/, "").trim()}\n`)
      }
      cb.onDone()
      return
    }
    if (system.startsWith("You are an expert research analyst")) {
      if (analysisError) {
        cb.onError(new Error(analysisError))
        return
      }
      cb.onToken([
        "## Key Concepts",
        "- Agent Harness Engineering: designing an agent's environment.",
        "",
        "## Topics",
        "Agent Harness Engineering",
        "OpenClaw Gateway",
      ].join("\n"))
      cb.onDone()
      return
    }
    if (system.startsWith("You are a wiki maintainer")) {
      cb.onToken(generationReply)
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }
    cb.onDone()
  }),
}))

import { autoIngest } from "./ingest"

const SOURCE = "harness-notes.md"
const SOURCE_TEXT = "# Harness notes\n\nNotes on agent harness engineering and the OpenClaw gateway.\n"

function page(type: string, title: string, sources: string[], body: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-09-30",
    "updated: 2026-09-30",
    "tags: []",
    "related: []",
    `sources: [${sources.map((s) => `"${s}"`).join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n")
}

function fileBlock(relPath: string, content: string): string {
  return `---FILE: ${relPath}---\n${content}---END FILE---`
}

const summaryBlock = fileBlock(
  "wiki/sources/harness-notes.md",
  page("source", "Harness Notes", [SOURCE], "Summary of the harness notes."),
)
const conceptUpdateBlock = fileBlock(
  "wiki/concepts/agent-harness-engineering.md",
  page("concept", "Agent Harness Engineering", [SOURCE], "The harness notes add a gateway section."),
)
const newEntityBlock = fileBlock(
  "wiki/entities/harness-gateway.md",
  page("entity", "Harness Gateway", [SOURCE], "A gateway named in the harness notes."),
)

function llmConfig(): LlmConfig {
  return { ...useWikiStore.getState().llmConfig, model: "fake-model", maxContextSize: 204_800 }
}

describe("autoIngest records each run in .llm-wiki/ingest-runs.jsonl", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  let recordPath: string

  async function records(): Promise<Array<Record<string, unknown>>> {
    const text = await readFileRaw(recordPath)
    expect(text.endsWith("\n")).toBe(true)
    return text.trimEnd().split("\n").map((line) => JSON.parse(line))
  }

  function ingest(): Promise<string[]> {
    return autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())
  }

  beforeEach(async () => {
    searchHits = { "OpenClaw Gateway": [{ id: "entities/openclaw", score: 0.9 }] }
    searchQueries.length = 0
    resetEmbeddingOptimizeAccountingForTests()
    analysisError = null
    generationReply = [summaryBlock, conceptUpdateBlock, newEntityBlock].join("\n")
    mergeReply = null

    tmp = await createTempProject("ingest-run-record")
    recordPath = `${tmp.path}/.llm-wiki/ingest-runs.jsonl`
    await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nAgent harness research.\n")
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n\nThe wiki covers agent harnesses.\n")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/agent-harness-engineering.md`,
      page("concept", "Agent Harness Engineering", ["loop-engineering.md"], "Harness engineering designs the agent's environment."),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/entities/openclaw.md`,
      page("entity", "OpenClaw", ["openclaw-docs.md"], "OpenClaw is an agent gateway."),
    )
    await writeFileRaw(`${tmp.path}/raw/sources/${SOURCE}`, SOURCE_TEXT)

    useReviewStore.setState({ items: [] })
    useActivityStore.setState({ items: [] })
    useWikiStore.setState({
      project: { id: "ingest-run-record", name: "ingest-run-record", path: tmp.path },
      fileTree: [],
      outputLanguage: "auto",
      activePresetId: "openai",
      projectLlmOverride: { enabled: false, presetId: null, model: "" },
      taskModelRouting: { chatPresetId: null, ingestPresetId: "anthropic" },
      multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
      embeddingConfig: { enabled: true, endpoint: "http://embed.invalid", apiKey: "", model: "fake-embed" },
      mineruConfig: { enabled: false, backend: "cloud", token: "", modelVersion: "vlm" },
    })
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  it("records a done ingest: the candidates offered and how each was found, and the pages updated and created", async () => {
    await ingest()

    const lines = await records()
    expect(lines).toHaveLength(1)
    const [record] = lines
    expect(record).toMatchObject({
      source: SOURCE,
      contentHash: createHash("sha256").update(SOURCE_TEXT).digest("hex"),
      outcome: "done",
      presetId: "anthropic",
      model: "fake-model",
      topics: ["Agent Harness Engineering", "OpenClaw Gateway"],
      candidates: [
        { path: "wiki/concepts/agent-harness-engineering.md", foundBy: ["exact-slug"] },
        { path: "wiki/entities/openclaw.md", foundBy: ["vector-search"] },
      ],
      searchSkipped: [],
      updatedPages: ["wiki/concepts/agent-harness-engineering.md"],
      createdPages: ["wiki/sources/harness-notes.md", "wiki/entities/harness-gateway.md"],
      mergeFallbacks: [],
    })
    expect(record.reason).toBeUndefined()
    expect(Date.parse(String(record.startedAt))).toBeLessThanOrEqual(Date.parse(String(record.finishedAt)))

    // The record's counts are the ones the same ingest's log entry states.
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).toContain("- Existing pages offered: 2. Existing pages updated: 1. Pages created: 2.")
  })

  it("names both finders when a page matches a topic's slug and a search hit", async () => {
    searchHits = { "Agent Harness Engineering": [{ id: "concepts/agent-harness-engineering", score: 0.95 }] }

    await ingest()

    const [record] = await records()
    expect(record.candidates).toEqual([
      { path: "wiki/concepts/agent-harness-engineering.md", foundBy: ["exact-slug", "vector-search"] },
    ])
  })

  it("records why the existing-page search was skipped", async () => {
    useWikiStore.setState({
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    })

    await ingest()

    const [record] = await records()
    expect(record.searchSkipped).toEqual(["Existing-page search skipped: embeddings are off"])
    expect(record.candidates).toEqual([
      { path: "wiki/concepts/agent-harness-engineering.md", foundBy: ["exact-slug"] },
    ])
  })

  it("records a rejected merge that fell back, with its reason", async () => {
    mergeReply = "Merged body with no frontmatter."

    await ingest()

    const [record] = await records()
    expect(record.outcome).toBe("done")
    expect(record.updatedPages).toEqual(["wiki/concepts/agent-harness-engineering.md"])
    expect(record.mergeFallbacks).toEqual([
      { path: "wiki/concepts/agent-harness-engineering.md", reason: "merge reply has no frontmatter" },
    ])
  })

  it("records a failed ingest with the model's error", async () => {
    analysisError = "model unavailable (503)"

    await expect(ingest()).rejects.toThrow("model unavailable (503)")

    const lines = await records()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      source: SOURCE,
      contentHash: createHash("sha256").update(SOURCE_TEXT).digest("hex"),
      outcome: "failed",
      reason: "Analysis failed: model unavailable (503)",
      presetId: "anthropic",
    })
    expect(lines[0].candidates).toBeUndefined()
  })

  it("records a cache-hit re-ingest as skipped, with the reason", async () => {
    await ingest()
    await ingest()

    const lines = await records()
    expect(lines.map((line) => line.outcome)).toEqual(["done", "skipped"])
    expect(lines[1]).toMatchObject({
      source: SOURCE,
      contentHash: lines[0].contentHash,
      reason: "cache hit: source unchanged since its last ingest",
    })
  })

  it("keeps the ingest's result when the record cannot be written", async () => {
    await fs.mkdir(recordPath, { recursive: true })
    const warn = vi.spyOn(console, "warn")

    const written = await ingest()

    expect(written).toContain("wiki/concepts/agent-harness-engineering.md")
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[ingest] Failed to write ingest run record"),
      expect.anything(),
    )
    warn.mockRestore()
  })
})
