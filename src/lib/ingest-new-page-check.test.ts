import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

// The embedding endpoint and vector store are faked under the real search.
// A text's vector marks which of a few subject words it contains, ignoring
// spaces and hyphens, so "Todo Write" and "TodoWrite" embed the same. The
// store holds one chunk per indexed page and ranks them by cosine.
const SUBJECTS = ["todo", "gateway", "harness"]
function fakeVector(text: string): number[] {
  const letters = text.toLowerCase().replace(/[^a-z]/g, "")
  return [...SUBJECTS.map((word) => (letters.includes(word) ? 1 : 0)), 0.1]
}
function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0)
  return dot / (Math.hypot(...a) * Math.hypot(...b))
}

let vectorIndex: Array<{ id: string; text: string }> = []
let embeddingDown = false
let vectorStoreDown = false
let embeddingCalls = 0

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>()
  return {
    ...actual,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "embedding_fetch") {
        embeddingCalls++
        if (embeddingDown) throw new Error("connection refused")
        return fakeVector(String(args?.text))
      }
      if (cmd === "vector_search_chunks") {
        if (vectorStoreDown) throw new Error("table wiki_chunks_v2 not found")
        const query = args?.queryEmbedding as number[]
        return vectorIndex
          .map((page) => ({
            chunk_id: `${page.id}#0`,
            page_id: page.id,
            chunk_index: 0,
            chunk_text: page.text,
            heading_path: "",
            score: cosine(query, fakeVector(page.text)),
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

const summaryBlock = fileBlock("wiki/sources/task-notes.md", page("source", "Task Notes", "Notes on task lists."))
const todoWriteTwinBlock = fileBlock(
  "wiki/entities/todowrite.md",
  page("entity", "TodoWrite", "TodoWrite is the tool an agent uses to keep its task list."),
)
const newPageBlock = fileBlock(
  "wiki/concepts/release-calendar.md",
  page("concept", "Release Calendar", "A calendar of planned releases."),
)
const gatewayBlock = fileBlock(
  "wiki/entities/gateway.md",
  page("entity", "Gateway", "The gateway routes an agent's model calls."),
)
const gatewayTwinBlock = fileBlock(
  "wiki/concepts/model-gateway.md",
  page("concept", "Model Gateway", "A model gateway routes an agent's model calls."),
)
const harnessUpdateBlock = fileBlock(
  "wiki/concepts/agent-harness-engineering.md",
  page("concept", "Agent Harness Engineering", "The task notes add a section on task lists."),
)

function llmConfig(): LlmConfig {
  return { ...useWikiStore.getState().llmConfig, model: "fake-model", maxContextSize: 204_800 }
}

describe("autoIngest checks each new concept or entity page against existing pages by meaning", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }

  function ingest(): Promise<string[]> {
    return autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())
  }

  async function log(): Promise<string> {
    return readFileRaw(`${tmp.path}/wiki/log.md`)
  }

  async function lastRecord(): Promise<Record<string, unknown>> {
    const lines = (await readFileRaw(`${tmp.path}/.llm-wiki/ingest-runs.jsonl`)).trimEnd().split("\n")
    return JSON.parse(lines[lines.length - 1])
  }

  function duplicateReviews() {
    return useReviewStore.getState().items.filter((item) => item.type === "duplicate")
  }

  beforeEach(async () => {
    embeddingDown = false
    vectorStoreDown = false
    embeddingCalls = 0
    resetEmbeddingOptimizeAccountingForTests()
    generationReply = [summaryBlock, todoWriteTwinBlock].join("\n")

    tmp = await createTempProject("ingest-new-page-check")
    await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nAgent tooling research.\n")
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
    await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n")
    await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
    await writeFileRaw(
      `${tmp.path}/wiki/entities/todo-write.md`,
      page("entity", "Todo Write", "Todo Write keeps an agent's task list."),
    )
    await writeFileRaw(
      `${tmp.path}/wiki/concepts/agent-harness-engineering.md`,
      page("concept", "Agent Harness Engineering", "Harness engineering designs the agent's environment."),
    )
    await writeFileRaw(`${tmp.path}/raw/sources/${SOURCE}`, "# Task notes\n\nHow agents keep task lists.\n")
    vectorIndex = [
      { id: "entities/todo-write", text: "Todo Write\n\nTodo Write keeps an agent's task list." },
      { id: "concepts/agent-harness-engineering", text: "Agent Harness Engineering\n\nHarness engineering." },
    ]

    useReviewStore.setState({ items: [] })
    useActivityStore.setState({ items: [] })
    useWikiStore.setState({
      project: { id: "ingest-new-page-check", name: "ingest-new-page-check", path: tmp.path },
      fileTree: [],
      outputLanguage: "auto",
      activePresetId: "openai",
      projectLlmOverride: { enabled: false, presetId: null, model: "" },
      taskModelRouting: { chatPresetId: null, ingestPresetId: null },
      multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
      embeddingConfig: { enabled: true, endpoint: "http://embed.invalid", apiKey: "", model: "fake-embed" },
      mineruConfig: { enabled: false, backend: "cloud", token: "", modelVersion: "vlm" },
    })
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  it("flags a new TodoWrite page against the existing Todo Write page, naming both and the score", async () => {
    const written = await ingest()

    expect(written).toContain("wiki/entities/todowrite.md")
    expect(await readFileRaw(`${tmp.path}/wiki/entities/todowrite.md`)).toContain("title: TodoWrite")
    const text = await log()
    expect(text).toContain("- New concept and entity pages checked against existing pages: 1. Near-duplicates flagged: 1.")
    expect(text).toContain(
      "- Near-duplicate flagged: wiki/entities/todowrite.md is close to wiki/entities/todo-write.md (score 1.000).",
    )
    expect((await lastRecord()).newPageCheck).toEqual({
      checked: ["wiki/entities/todowrite.md"],
      flagged: [{ path: "wiki/entities/todowrite.md", existingPath: "wiki/entities/todo-write.md", score: 1 }],
    })
    const reviews = duplicateReviews()
    expect(reviews).toHaveLength(1)
    expect(reviews[0].affectedPages).toEqual(["wiki/entities/todowrite.md", "wiki/entities/todo-write.md"])
    expect(reviews[0].description).toContain("1.000")
    expect(reviews[0].options.map((option) => option.action)).toEqual([
      "open:wiki/entities/todowrite.md",
      "open:wiki/entities/todo-write.md",
      "Skip",
    ])
  })

  it("passes a genuinely new page unflagged, and checks neither updated pages nor the source summary", async () => {
    generationReply = [summaryBlock, newPageBlock, harnessUpdateBlock].join("\n")

    await ingest()

    expect(await log()).toContain(
      "- New concept and entity pages checked against existing pages: 1. Near-duplicates flagged: 0.",
    )
    expect((await lastRecord()).newPageCheck).toEqual({
      checked: ["wiki/concepts/release-calendar.md"],
      flagged: [],
    })
    expect(duplicateReviews()).toHaveLength(0)
  })

  it("flags two twins created by the same ingest as one pair", async () => {
    generationReply = [summaryBlock, gatewayBlock, gatewayTwinBlock].join("\n")

    await ingest()

    const text = await log()
    expect(text).toContain("- New concept and entity pages checked against existing pages: 2. Near-duplicates flagged: 1.")
    expect(text).toContain(
      "- Near-duplicate flagged: wiki/concepts/model-gateway.md is close to wiki/entities/gateway.md, also created by this ingest (score 1.000).",
    )
    expect((await lastRecord()).newPageCheck).toEqual({
      checked: ["wiki/entities/gateway.md", "wiki/concepts/model-gateway.md"],
      flagged: [
        { path: "wiki/concepts/model-gateway.md", existingPath: "wiki/entities/gateway.md", score: 1, sameIngest: true },
      ],
    })
    const reviews = duplicateReviews()
    expect(reviews).toHaveLength(1)
    expect(reviews[0].affectedPages).toEqual(["wiki/concepts/model-gateway.md", "wiki/entities/gateway.md"])
    expect(reviews[0].description).toContain("Ingest created both wiki/concepts/model-gateway.md and wiki/entities/gateway.md")
    expect(reviews[0].options.map((option) => option.label)).toEqual(["Open new page", "Open other new page", "Skip"])
  })

  it("makes no embedding call for the check when the ingest is cancelled before it", async () => {
    const controller = new AbortController()

    // The index update is the last write before the check. Calls counted
    // from the abort are the check's: the candidate search embeds earlier.
    await expect(
      autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig(), controller.signal, undefined, (path) => {
        if (path !== "wiki/index.md") return
        controller.abort()
        embeddingCalls = 0
      }),
    ).rejects.toThrow()

    expect(await readFileRaw(`${tmp.path}/wiki/entities/todowrite.md`)).toContain("title: TodoWrite")
    expect(embeddingCalls).toBe(0)
    expect((await lastRecord()).newPageCheck).toEqual({ checked: [], flagged: [], skipped: "ingest cancelled" })
    expect(duplicateReviews()).toHaveLength(0)
  })

  it("finds a twin whose vectors are stored under a bare slug", async () => {
    vectorIndex = [{ id: "todo-write", text: "Todo Write\n\nTodo Write keeps an agent's task list." }]

    await ingest()

    expect(await log()).toContain(
      "- Near-duplicate flagged: wiki/entities/todowrite.md is close to wiki/entities/todo-write.md (score 1.000).",
    )
  })

  it("completes the ingest and logs the skip when the embedding endpoint is down", async () => {
    embeddingDown = true

    const written = await ingest()

    expect(written).toContain("wiki/entities/todowrite.md")
    const text = await log()
    expect(text).toContain("- New concept and entity pages checked against existing pages: 0. Near-duplicates flagged: 0.")
    expect(text).toContain("- New-page check skipped: embedding failed: connection refused.")
    const record = await lastRecord()
    expect(record.outcome).toBe("done")
    expect(record.newPageCheck).toEqual({
      checked: [],
      flagged: [],
      skipped: "embedding failed: connection refused",
    })
    expect(duplicateReviews()).toHaveLength(0)
  })

  it("completes the ingest and logs the skip when the vector store fails", async () => {
    vectorStoreDown = true

    const written = await ingest()

    expect(written).toContain("wiki/entities/todowrite.md")
    expect(await log()).toContain(
      "- New-page check skipped: search failed: vector store: table wiki_chunks_v2 not found.",
    )
    expect((await lastRecord()).outcome).toBe("done")
  })

  it("completes the ingest and logs the skip when an existing page cannot be read", async () => {
    // A folder where the search hit's page file should be: it exists, but
    // reading it fails.
    await fs.mkdir(`${tmp.path}/wiki/entities/todo-list.md`, { recursive: true })
    vectorIndex = [{ id: "entities/todo-list", text: "Todo List" }]

    const written = await ingest()

    expect(written).toContain("wiki/entities/todowrite.md")
    expect(await log()).toMatch(/- New-page check skipped: .*EISDIR.*\./)
    expect((await lastRecord()).outcome).toBe("done")
  })

  it("logs the skip when embeddings are off", async () => {
    useWikiStore.setState({
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    })

    await ingest()

    expect(await log()).toContain("- New-page check skipped: embeddings are off.")
  })
})
