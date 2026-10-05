import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { computeContextBudget } from "./context-budget"

let listingFails = false
vi.mock("@/commands/fs", () => ({
  ...realFs,
  listDirectory: async (p: string) => {
    if (listingFails) throw new Error("permission denied")
    return realFs.listDirectory(p)
  },
}))

vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))

// The embedding search is faked at its public boundary: per query, the
// page ids it returns; or an error it throws; or a recorded fetch error.
let searchHits: Record<string, Array<{ id: string; score: number }>> = {}
let searchThrows: Error | null = null
let lastEmbeddingError: string | null = null
const searchQueries: string[] = []

vi.mock("@/lib/embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding")>()
  return {
    wikiPageIdFromPath: actual.wikiPageIdFromPath,
    embedPage: vi.fn(async () => {}),
    getLastEmbeddingError: () => lastEmbeddingError,
    searchByEmbedding: vi.fn(async (_project: string, query: string) => {
      searchQueries.push(query)
      if (searchThrows) throw searchThrows
      return searchHits[query] ?? []
    }),
  }
})

// The model fake routes on the system prompt and records every request.
let analysisReply = ""
let chunkDigestTopics = ""
let chunkDigestPadding = ""
let generationReply = ""
let mergeCalls = 0
const generationRequests: Array<{ system: string; user: string }> = []

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const system = String(messages?.[0]?.content ?? "")
    const user = String(messages?.[1]?.content ?? "")
    if (system.startsWith("You are merging source-backed material")) {
      mergeCalls++
      const [previous = "", additional = ""] = user.split(/\n\n---\n\n## Additional material[^\n]*\n\n/)
      const existing = previous.replace(/^## Previously collected material[^\n]*\n\n/, "")
      const incoming = additional.split("\n\n---\n\nNow output the merged file")[0]
      const existingBody = existing.replace(/^---\n[\s\S]*?\n---\n/, "")
      cb.onToken(`${incoming.trim()}\n\n${existingBody.trim()}\n`)
      cb.onDone()
      return
    }
    if (system.startsWith("You are analyzing a long source document")) {
      const chunk = user.match(/Chunk:\s*(\d+)\/(\d+)/)?.[1] ?? "0"
      cb.onToken([
        "## Chunk Analysis",
        `Chunk ${chunk} notes.`,
        "",
        "## Updated Global Digest",
        chunkDigestTopics,
        "",
        `Digest after chunk ${chunk}. ${chunkDigestPadding}`,
      ].join("\n"))
      cb.onDone()
      return
    }
    if (system.startsWith("You are an expert research analyst")) {
      cb.onToken(analysisReply)
      cb.onDone()
      return
    }
    if (system.startsWith("You are a wiki maintainer")) {
      generationRequests.push({ system, user })
      cb.onToken(generationReply)
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }
    cb.onDone()
  }),
}))

import { autoIngest } from "./ingest"

const SOURCE = "harness-notes.md"

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
  `wiki/sources/harness-notes.md`,
  page("source", "Harness Notes", [SOURCE], "Summary of the harness notes."),
)

function llmConfig(maxContextSize = 204_800): LlmConfig {
  return { ...useWikiStore.getState().llmConfig, maxContextSize }
}

function lastGeneration(): { system: string; user: string } {
  const request = generationRequests[generationRequests.length - 1]
  if (!request) throw new Error("no generation request reached the model")
  return request
}

describe("autoIngest offers existing pages before generation", () => {
  let tmp: { path: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    searchHits = {}
    searchThrows = null
    lastEmbeddingError = null
    searchQueries.length = 0
    analysisReply = [
      "## Key Concepts",
      "- Agent Harness Engineering: designing an agent's environment.",
      "",
      "## Topics",
      "Agent Harness Engineering",
      "OpenClaw Gateway",
    ].join("\n")
    chunkDigestTopics = ""
    chunkDigestPadding = ""
    listingFails = false
    generationReply = summaryBlock
    mergeCalls = 0
    generationRequests.length = 0

    tmp = await createTempProject("ingest-candidates")
    await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nAgent harness research.\n")
    await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n\n## Recently Updated\n- [[concepts/agent-harness-engineering]] — Agent Harness Engineering\n")
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
    await writeFileRaw(
      `${tmp.path}/wiki/sources/openclaw-docs.md`,
      page("source", "OpenClaw Docs", ["openclaw-docs.md"], "Summary of another source."),
    )
    await writeFileRaw(`${tmp.path}/raw/sources/${SOURCE}`, "# Harness notes\n\nNotes on agent harness engineering and the OpenClaw gateway.\n")

    useReviewStore.setState({ items: [] })
    useActivityStore.setState({ items: [] })
    useWikiStore.setState({
      project: { id: "ingest-candidates", name: "ingest-candidates", path: tmp.path },
      fileTree: [],
      outputLanguage: "auto",
      multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
      embeddingConfig: { enabled: true, endpoint: "http://embed.invalid", apiKey: "", model: "fake-embed" },
      mineruConfig: { enabled: false, backend: "cloud", token: "", modelVersion: "vlm" },
    })
  })

  afterEach(async () => {
    await tmp.cleanup()
  })

  it("searches once per listed topic and gives generation the candidates' paths and text", async () => {
    searchHits = {
      "OpenClaw Gateway": [
        { id: "sources/openclaw-docs", score: 0.95 },
        { id: "entities/openclaw", score: 0.9 },
        { id: "index", score: 0.8 },
        { id: "overview", score: 0.8 },
        { id: "log", score: 0.8 },
      ],
    }

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(searchQueries).toEqual(["Agent Harness Engineering", "OpenClaw Gateway"])
    const { system } = lastGeneration()
    expect(system).toContain('<existing-page path="wiki/concepts/agent-harness-engineering.md">')
    expect(system).toContain("Harness engineering designs the agent's environment.")
    expect(system).toContain('<existing-page path="wiki/entities/openclaw.md">')
    expect(system).toContain("OpenClaw is an agent gateway.")
    expect(system).not.toContain('<existing-page path="wiki/sources/openclaw-docs.md">')
    expect(system).not.toContain('<existing-page path="wiki/index.md">')
    expect(system).not.toContain('<existing-page path="wiki/overview.md">')
    expect(system).not.toContain('<existing-page path="wiki/log.md">')
    expect(system.indexOf("## Existing Pages for This Source")).toBeLessThan(system.indexOf("## Output Format"))
    expect(system).toContain("partial, read-only list of recently updated pages")
  })

  it("merges a write to a candidate path into the existing page instead of creating a new one", async () => {
    generationReply = [
      summaryBlock,
      fileBlock(
        "wiki/concepts/agent-harness-engineering.md",
        page("concept", "Agent Harness Engineering", [SOURCE], "Harness notes add the gateway pattern."),
      ),
    ].join("\n\n")
    const before = await fs.readdir(path.join(tmp.path, "wiki", "concepts"))

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(await fs.readdir(path.join(tmp.path, "wiki", "concepts"))).toEqual(before)
    const merged = await readFileRaw(`${tmp.path}/wiki/concepts/agent-harness-engineering.md`)
    expect(merged).toContain("loop-engineering.md")
    expect(merged).toContain(SOURCE)
    expect(merged).toContain("Harness engineering designs the agent's environment.")
    expect(merged).toContain("Harness notes add the gateway pattern.")
    expect(mergeCalls).toBe(1)
  })

  it("still offers the exact-path candidate and records why when embeddings are off", async () => {
    useWikiStore.setState({
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    })

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(written).toContain("wiki/sources/harness-notes.md")
    expect(searchQueries).toEqual([])
    expect(lastGeneration().system).toContain('<existing-page path="wiki/concepts/agent-harness-engineering.md">')
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).toContain("Existing-page search skipped: embeddings are off.")
  })

  it("still offers the exact-path candidate and records why when the search fails", async () => {
    searchThrows = new Error("vector store unavailable")

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(written).toContain("wiki/sources/harness-notes.md")
    expect(lastGeneration().system).toContain('<existing-page path="wiki/concepts/agent-harness-engineering.md">')
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).toContain("Existing-page search skipped: search failed: vector store unavailable.")
  })

  it("records an embedding fetch error that the search swallowed as a skipped search", async () => {
    lastEmbeddingError = "HTTP 401 from embedding endpoint"

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).toContain("Existing-page search skipped: search failed: HTTP 401 from embedding endpoint.")
  })

  it("uses the whole analysis as one query when the topics list is missing", async () => {
    analysisReply = "## Key Concepts\n- Agent Harness Engineering"

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(searchQueries).toEqual([analysisReply])
  })

  it.each([
    ["bullets and numbering", "## Topics\n- Agent Harness Engineering\n2. OpenClaw Gateway", ["Agent Harness Engineering", "OpenClaw Gateway"]],
    ["a bold heading with a colon and bold names", "**Topics:**\n**Agent Harness Engineering**\nOpenClaw Gateway", ["Agent Harness Engineering", "OpenClaw Gateway"]],
    ["blank lines before the list and a duplicate", "## Topics\n\nAgent Harness Engineering\nagent harness engineering\nOpenClaw Gateway", ["Agent Harness Engineering", "OpenClaw Gateway"]],
    ["prose after a blank line", "## Topics\nAgent Harness Engineering\n\nThat is all.", ["Agent Harness Engineering"]],
    ["a heading after the list", "## Topics\nAgent Harness Engineering\n## Notes\nNot a topic", ["Agent Harness Engineering"]],
    ["the last of two topics sections", "## Topics\nOld Topic\n\n## Topics\nOpenClaw Gateway", ["OpenClaw Gateway"]],
    ["more than twenty topics", `## Topics\n${Array.from({ length: 25 }, (_, i) => `Topic ${i}`).join("\n")}`, Array.from({ length: 20 }, (_, i) => `Topic ${i}`)],
  ])("reads a topics list with %s", async (_form, topics, expected) => {
    analysisReply = `## Key Concepts\n- Agent Harness Engineering\n\n${topics}`

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(searchQueries).toEqual(expected)
  })

  it("records a failed wiki listing as a skipped exact-path check and still completes", async () => {
    listingFails = true
    searchHits = { "OpenClaw Gateway": [{ id: "entities/openclaw", score: 0.9 }] }

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(written).toContain("wiki/sources/harness-notes.md")
    expect(lastGeneration().system).toContain('<existing-page path="wiki/entities/openclaw.md">')
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).toContain("Exact-path check skipped: wiki listing failed: permission denied.")
  })

  it("caps the candidate block by page count and by text, and the source still fits", async () => {
    const maxContextSize = 60_000
    const { pageBudget, maxPageSize, responseReserve } = computeContextBudget(maxContextSize)
    const hits: Array<{ id: string; score: number }> = []
    for (let i = 0; i < 20; i++) {
      const slug = `harness-pattern-${String(i).padStart(2, "0")}`
      await writeFileRaw(
        `${tmp.path}/wiki/concepts/${slug}.md`,
        page("concept", `Harness Pattern ${i}`, ["other.md"], `Pattern ${i}. ${"detail ".repeat(400)}`),
      )
      hits.push({ id: `concepts/${slug}`, score: 0.9 - i / 100 })
    }
    searchHits = { "OpenClaw Gateway": hits }
    chunkDigestTopics = "### Topics\nOpenClaw Gateway"
    await writeFileRaw(`${tmp.path}/wiki/index.md`, `# Index\n\n## Recently Updated\n${"- [[concepts/x]] — X\n".repeat(400)}`)
    await writeFileRaw(`${tmp.path}/raw/sources/${SOURCE}`, `# Harness notes\n\n${"Harness engineering sentence. ".repeat(800)}`)

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig(maxContextSize))

    const { system, user } = lastGeneration()
    const block = system.slice(
      system.indexOf("## Existing Pages for This Source"),
      system.indexOf("## Output Format"),
    )
    const offered = block.match(/<existing-page path=/g) ?? []
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.length).toBeLessThanOrEqual(12)
    expect(block.length).toBeLessThanOrEqual(Math.floor(pageBudget * 0.3) + 2_000)
    for (const body of block.split("<existing-page").slice(1)) {
      expect(body.length).toBeLessThanOrEqual(maxPageSize + 200)
    }
    expect(system.length + user.length).toBeLessThanOrEqual(maxContextSize - responseReserve)
  })

  it("gives a long source analysed in pieces the same candidate step", async () => {
    chunkDigestTopics = "### Topics\nAgent Harness Engineering\nOpenClaw Gateway"
    // Longer than the digest cap, so the digest is trimmed from its end.
    chunkDigestPadding = "Further digest detail. ".repeat(1_000)
    searchHits = { "OpenClaw Gateway": [{ id: "entities/openclaw", score: 0.9 }] }
    const paragraphs = Array.from({ length: 60 }, (_, i) => `## Part ${i}\n\n${"Harness engineering detail. ".repeat(60)}`)
    await writeFileRaw(`${tmp.path}/raw/sources/${SOURCE}`, `# Harness notes\n\n${paragraphs.join("\n\n")}`)

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig(40_000))

    expect(lastGeneration().user).toContain("Consolidated Long-Document Analysis")
    expect(searchQueries).toEqual(["Agent Harness Engineering", "OpenClaw Gateway"])
    const { system } = lastGeneration()
    expect(system).toContain('<existing-page path="wiki/concepts/agent-harness-engineering.md">')
    expect(system).toContain('<existing-page path="wiki/entities/openclaw.md">')
  })

  it("records candidates offered, existing pages updated and pages created in the log entry", async () => {
    searchHits = { "OpenClaw Gateway": [{ id: "entities/openclaw", score: 0.9 }] }
    generationReply = [
      summaryBlock,
      fileBlock(
        "wiki/concepts/agent-harness-engineering.md",
        page("concept", "Agent Harness Engineering", [SOURCE], "Harness notes add the gateway pattern."),
      ),
      fileBlock(
        "wiki/concepts/gateway-pattern.md",
        page("concept", "Gateway Pattern", [SOURCE], "A new concept."),
      ),
    ].join("\n\n")

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).toContain(`ingest | ${SOURCE}`)
    expect(log).toContain("Existing pages offered: 2. Existing pages updated: 1. Pages created: 2.")
    expect(log).not.toContain("search skipped")
  })

  it("appends the counts under the model's own log entry when it wrote one", async () => {
    generationReply = [
      summaryBlock,
      fileBlock("wiki/log.md", "## [2026-10-05] ingest | Harness Notes\n- Added the summary.\n"),
    ].join("\n\n")

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log.indexOf("- Added the summary.")).toBeLessThan(
      log.indexOf("Existing pages offered: 1. Existing pages updated: 0. Pages created: 1."),
    )
    expect(log).not.toContain(`ingest | ${SOURCE}`)
  })
})
