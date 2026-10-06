/**
 * The new-page check (#69) through autoIngest on a real embedding endpoint.
 * The model's generation is scripted and the vector store is an in-memory
 * cosine search over the endpoint's real vectors (LanceDB is not reachable
 * under Node); the embeddings, the files and the threshold are real.
 *
 * Gated behind RUN_LLM_TESTS=1, EMBEDDING_ENDPOINT and EMBEDDING_MODEL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"

vi.mock("@/commands/fs", () => realFs)

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

async function realEmbedding(text: string, cfg: { endpoint: string; model: string }): Promise<number[]> {
  const response = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input: text }),
  })
  if (!response.ok) throw new Error(`embedding endpoint answered ${response.status}`)
  return (await response.json()).data[0].embedding
}

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0)
  return dot / (Math.hypot(...a) * Math.hypot(...b))
}

let vectorIndex: Array<{ id: string; vector: number[] }> = []

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>()
  return {
    ...actual,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "embedding_fetch") {
        return realEmbedding(String(args?.text), args?.cfg as { endpoint: string; model: string })
      }
      if (cmd === "vector_search_chunks") {
        const query = args?.queryEmbedding as number[]
        return vectorIndex
          .map((page) => ({
            chunk_id: `${page.id}#0`,
            page_id: page.id,
            chunk_index: 0,
            chunk_text: "",
            heading_path: "",
            score: cosine(query, page.vector),
          }))
          .sort((a, b) => b.score - a.score)
      }
      return actual.invoke(cmd, args)
    },
  }
})

vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding")>()
  return { ...actual, embedPage: vi.fn(async () => {}) }
})

let generationReply = ""

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const system = String(messages?.[0]?.content ?? "")
    if (system.startsWith("You are an expert research analyst")) {
      cb.onToken("## Key Concepts\n- Task lists.\n\n## Topics\nTask Lists\n")
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

const ENABLED =
  process.env.RUN_LLM_TESTS === "1" &&
  !!process.env.EMBEDDING_ENDPOINT &&
  !!process.env.EMBEDDING_MODEL

const SOURCE = "task-notes.md"

function page(type: string, title: string, body: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-09-30",
    "updated: 2026-09-30",
    "tags: []",
    "related: []",
    `sources: ["${SOURCE}"]`,
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

const EXISTING = {
  "entities/todo-write": page(
    "entity",
    "Todo Write",
    "Todo Write is Claude Code's task-list tool: the agent writes its checklist of tasks and marks each one done as it works.",
  ),
  "concepts/agent-harness-engineering": page(
    "concept",
    "Agent Harness Engineering",
    "Agent harness engineering designs the runtime around a language model: its tools, context and control loop.",
  ),
}
const summaryBlock = fileBlock("wiki/sources/task-notes.md", page("source", "Task Notes", "Notes on how agents keep task lists."))
const todoWriteBlock = fileBlock(
  "wiki/entities/todowrite.md",
  page("entity", "TodoWrite", "TodoWrite is the Claude Code tool an agent uses to write and update its checklist of tasks."),
)
const newPageBlock = fileBlock(
  "wiki/concepts/release-calendar.md",
  page("concept", "Release Calendar", "A release calendar lists the planned dates of a product's upcoming versions."),
)
const releaseCalendarTwinBlock = fileBlock(
  "wiki/entities/release-calendar.md",
  page("entity", "Release Calendar", "The release calendar lists the planned dates of the product's upcoming versions."),
)

describe.skipIf(!ENABLED)("the new-page check on a real embedding endpoint", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }
  const endpoint = process.env.EMBEDDING_ENDPOINT ?? ""
  const model = process.env.EMBEDDING_MODEL ?? ""

  function llmConfig(): LlmConfig {
    return { ...useWikiStore.getState().llmConfig, model: "scripted-model", maxContextSize: 204_800 }
  }

  async function ingest(): Promise<{ written: string[]; log: string; record: Record<string, unknown> }> {
    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    const records = (await readFileRaw(`${tmp.path}/.llm-wiki/ingest-runs.jsonl`)).trimEnd().split("\n")
    return { written, log, record: JSON.parse(records[records.length - 1]) }
  }

  beforeEach(async () => {
    tmp = await createTempProject("ingest-new-page-check-live")
    await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nAgent tooling research.\n")
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
    await writeFileRaw(`${tmp.path}/raw/sources/${SOURCE}`, "# Task notes\n\nHow agents keep task lists.\n")
    vectorIndex = []
    for (const [id, content] of Object.entries(EXISTING)) {
      await writeFileRaw(`${tmp.path}/wiki/${id}.md`, content)
      vectorIndex.push({ id, vector: await realEmbedding(content, { endpoint, model }) })
    }
    useReviewStore.setState({ items: [] })
    useActivityStore.setState({ items: [] })
    useWikiStore.setState({
      project: { id: "ingest-new-page-check-live", name: "ingest-new-page-check-live", path: tmp.path },
      fileTree: [],
      outputLanguage: "auto",
      activePresetId: "openai",
      projectLlmOverride: { enabled: false, presetId: null, model: "" },
      taskModelRouting: { chatPresetId: null, ingestPresetId: null },
      multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
      embeddingConfig: { enabled: true, endpoint, apiKey: "", model },
      mineruConfig: { enabled: false, backend: "cloud", token: "", modelVersion: "vlm" },
    })
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  it("flags TodoWrite against the existing Todo Write page", async () => {
    generationReply = [summaryBlock, todoWriteBlock].join("\n")

    const { log, record } = await ingest()

    console.log(log)
    expect(log).toMatch(
      /- Near-duplicate flagged: wiki\/entities\/todowrite\.md is close to wiki\/entities\/todo-write\.md \(score 0\.\d{3}\)\./,
    )
    expect(record.newPageCheck).toMatchObject({ checked: ["wiki/entities/todowrite.md"] })
  }, 60_000)

  it("passes a genuinely new page unflagged", async () => {
    generationReply = [summaryBlock, newPageBlock].join("\n")

    const { log, record } = await ingest()

    console.log(log)
    expect(log).toContain("- New concept and entity pages checked against existing pages: 1. Near-duplicates flagged: 0.")
    expect(record.newPageCheck).toEqual({ checked: ["wiki/concepts/release-calendar.md"], flagged: [] })
  }, 60_000)

  it("flags two twins created by the same ingest as one pair", async () => {
    generationReply = [summaryBlock, newPageBlock, releaseCalendarTwinBlock].join("\n")

    const { log, record } = await ingest()

    console.log(log)
    expect(log).toMatch(
      /- Near-duplicate flagged: wiki\/entities\/release-calendar\.md is close to wiki\/concepts\/release-calendar\.md, also created by this ingest \(score 0\.\d{3}\)\./,
    )
    expect(record.newPageCheck).toMatchObject({
      flagged: [{ path: "wiki/entities/release-calendar.md", existingPath: "wiki/concepts/release-calendar.md", sameIngest: true }],
    })
  }, 60_000)

  it("completes the ingest and logs the skip with the embedding endpoint stopped", async () => {
    // A port that was free a moment ago and now has no listener.
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    useWikiStore.setState({
      embeddingConfig: { enabled: true, endpoint: `http://127.0.0.1:${port}/v1/embeddings`, apiKey: "", model },
    })
    generationReply = [summaryBlock, todoWriteBlock].join("\n")

    const { written, log, record } = await ingest()

    console.log(log)
    expect(written).toContain("wiki/entities/todowrite.md")
    expect(record.outcome).toBe("done")
    expect(log).toMatch(/- New-page check skipped: embedding failed: .+\./)
  }, 60_000)
})
