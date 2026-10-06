import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempProject, realFs, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { computeContextBudget } from "./context-budget"
import { resetEmbeddingOptimizeAccountingForTests } from "./embedding"

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

// The embedding search, which ingest falls back to, runs for real; the Tauri
// commands under it are faked.
// A query's vector is its position in `searchQueries`, and the vector store
// answers it with one chunk per page listed for that query in `searchHits`.
// Either command can fail instead, rejecting with a string as a Tauri
// command's error does.
let searchHits: Record<string, Array<{ id: string; score: number }>> = {}
let embeddingFetchError: string | null = null
let vectorStoreError: string | null = null
const searchQueries: string[] = []
// The hybrid search answers a query with the project-relative paths listed
// for it in `hybridHits`, best first, up to the requested count, and with
// `hybridVectorError` when set. Null stands for a hybrid search that fails,
// so the tests that leave it null run the vector-only fallback.
let hybridHits: Record<string, Array<{ path: string; score: number }>> | null = null
let hybridVectorError: string | null = null
const hybridRequests: Array<Record<string, unknown>> = []

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>()
  return {
    ...actual,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "embedding_fetch") {
        searchQueries.push(String(args?.text))
        if (embeddingFetchError) throw embeddingFetchError
        return [searchQueries.length - 1]
      }
      if (cmd === "search_project") {
        hybridRequests.push(args ?? {})
        if (!hybridHits) throw "search_project: index unavailable"
        const results = (hybridHits[String(args?.query)] ?? []).slice(0, Number(args?.topK))
        return {
          mode: "hybrid",
          results: results.map(({ path, score }) => ({ path, title: path, snippet: "", titleMatch: false, score, images: [] })),
          tokenHits: results.length,
          vectorHits: 0,
          graphHits: 0,
          ...(hybridVectorError ? { vectorError: hybridVectorError } : {}),
        }
      }
      if (cmd === "vector_search_chunks") {
        if (vectorStoreError) throw vectorStoreError
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
    embeddingFetchError = null
    vectorStoreError = null
    searchQueries.length = 0
    hybridHits = null
    hybridVectorError = null
    hybridRequests.length = 0
    resetEmbeddingOptimizeAccountingForTests()
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

  it("offers the next passing hits for a topic when its top hits are excluded or have no page", async () => {
    for (const slug of ["gateway-routing", "gateway-auth", "gateway-limits", "gateway-overflow"]) {
      await writeFileRaw(
        `${tmp.path}/wiki/concepts/${slug}.md`,
        page("concept", slug, ["other.md"], `About ${slug}.`),
      )
    }
    searchHits = {
      "OpenClaw Gateway": [
        { id: "sources/openclaw-docs", score: 0.99 },
        { id: "concepts/deleted-page", score: 0.98 },
        { id: "gateway-routing", score: 0.97 },
        { id: "index", score: 0.96 },
        { id: "concepts/gateway-routing", score: 0.9 },
        { id: "concepts/gateway-auth", score: 0.85 },
        { id: "concepts/gateway-limits", score: 0.8 },
        { id: "concepts/gateway-overflow", score: 0.75 },
      ],
    }

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    const offered = (lastGeneration().system.match(/<existing-page path="[^"]+">/g) ?? []).sort()
    expect(offered).toEqual([
      '<existing-page path="wiki/concepts/agent-harness-engineering.md">',
      '<existing-page path="wiki/concepts/gateway-auth.md">',
      '<existing-page path="wiki/concepts/gateway-limits.md">',
      '<existing-page path="wiki/concepts/gateway-routing.md">',
    ])
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).not.toContain("search skipped")
  })

  it("offers a page the hybrid search finds by keyword, asking it for matches only", async () => {
    analysisReply = "## Key Concepts\n- GPT-5.3\n\n## Topics\nGPT-5.3"
    await writeFileRaw(`${tmp.path}/wiki/entities/gpt-5-3.md`, page("entity", "GPT-5.3", ["other.md"], "A model release."))
    hybridHits = { "GPT-5.3": [{ path: "wiki/entities/gpt-5-3.md", score: 0.016 }] }

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(lastGeneration().system).toContain('<existing-page path="wiki/entities/gpt-5-3.md">')
    expect(searchQueries).toEqual([])
    expect(hybridRequests).toEqual([
      expect.objectContaining({
        projectPath: tmp.path,
        query: "GPT-5.3",
        includeGraph: false,
        embeddingConfig: useWikiStore.getState().embeddingConfig,
      }),
    ])
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).not.toContain("search skipped")
    expect(log).not.toContain("Hybrid search failed")
  })

  it("offers a page at the path the hybrid search gives for a bare-slug vector hit", async () => {
    searchHits = { "OpenClaw Gateway": [{ id: "openclaw", score: 0.9 }] }
    hybridHits = { "OpenClaw Gateway": [{ path: "wiki/entities/openclaw.md", score: 0.03 }] }

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(lastGeneration().system).toContain('<existing-page path="wiki/entities/openclaw.md">')
  })

  it("offers the next passing hybrid hits for a topic when its top hits are excluded or have no page", async () => {
    for (const slug of ["gateway-routing", "gateway-auth", "gateway-limits", "gateway-overflow"]) {
      await writeFileRaw(`${tmp.path}/wiki/concepts/${slug}.md`, page("concept", slug, ["other.md"], `About ${slug}.`))
    }
    const otherSummaries = Array.from({ length: 10 }, (_, i) => ({ path: `wiki/sources/other-${i}.md`, score: 0.05 }))
    for (const { path: summary } of otherSummaries) {
      await writeFileRaw(`${tmp.path}/${summary}`, page("source", summary, ["other.md"], "Another source."))
    }
    hybridHits = {
      "OpenClaw Gateway": [
        { path: "wiki/log.md", score: 0.06 },
        { path: "wiki/index.md", score: 0.06 },
        ...otherSummaries,
        { path: "wiki/concepts/deleted-page.md", score: 0.04 },
        { path: "wiki/concepts/gateway-routing.md", score: 0.03 },
        { path: "wiki/concepts/gateway-auth.md", score: 0.03 },
        { path: "wiki/concepts/gateway-limits.md", score: 0.02 },
        { path: "wiki/concepts/gateway-overflow.md", score: 0.02 },
      ],
    }

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    const offered = (lastGeneration().system.match(/<existing-page path="[^"]+">/g) ?? []).sort()
    expect(offered).toEqual([
      '<existing-page path="wiki/concepts/agent-harness-engineering.md">',
      '<existing-page path="wiki/concepts/gateway-auth.md">',
      '<existing-page path="wiki/concepts/gateway-limits.md">',
      '<existing-page path="wiki/concepts/gateway-routing.md">',
    ])
  })

  it("falls back to the vector search and logs why when the hybrid search fails", async () => {
    searchHits = { "OpenClaw Gateway": [{ id: "entities/openclaw", score: 0.9 }] }

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(hybridRequests).toHaveLength(1)
    expect(searchQueries).toEqual(["Agent Harness Engineering", "OpenClaw Gateway"])
    expect(lastGeneration().system).toContain('<existing-page path="wiki/entities/openclaw.md">')
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).toContain("Hybrid search failed, so the vector search was used: search_project: index unavailable.")
    expect(log).not.toContain("search skipped")
  })

  it("keeps the keyword hits and logs why once when the hybrid search's vector half fails", async () => {
    hybridHits = {
      "Agent Harness Engineering": [],
      "OpenClaw Gateway": [{ path: "wiki/entities/openclaw.md", score: 30 }],
    }
    hybridVectorError = "query embedding: HTTP 401 from embedding endpoint"

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(lastGeneration().system).toContain('<existing-page path="wiki/entities/openclaw.md">')
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    const line = "Existing-page search used keywords only: query embedding: HTTP 401 from embedding endpoint."
    expect(log.split(line)).toHaveLength(2)
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

  it("still offers the exact-path candidate and records why when the vector store fails", async () => {
    vectorStoreError = "Open table error: corrupt manifest"
    searchHits = { "OpenClaw Gateway": [{ id: "entities/openclaw", score: 0.9 }] }

    const written = await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig())

    expect(written).toContain("wiki/sources/harness-notes.md")
    const { system } = lastGeneration()
    expect(system).toContain('<existing-page path="wiki/concepts/agent-harness-engineering.md">')
    expect(system).not.toContain('<existing-page path="wiki/entities/openclaw.md">')
    const log = await readFileRaw(`${tmp.path}/wiki/log.md`)
    expect(log).toContain(
      "Existing-page search skipped: search failed: vector store: Open table error: corrupt manifest.",
    )
  })

  it("records a failed query embedding as a skipped search", async () => {
    embeddingFetchError = "HTTP 401 from embedding endpoint"

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
    ["blank lines between names and an intro line", "## Topics\nHere are the topics:\n\n- Agent Harness Engineering\n\n- OpenClaw Gateway\n", ["Agent Harness Engineering", "OpenClaw Gateway"]],
    ["a long line after the names", `## Topics\nAgent Harness Engineering\n${"word ".repeat(30)}`, ["Agent Harness Engineering"]],
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
