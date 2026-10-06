/**
 * Seam 4 of #67: a duplicate merge keeps the vector index fresh. Runs the
 * real `executeMerge`, then the real `reembedMergedPages` as the merge queue
 * does once it releases the project lock (#73), against a real temporary
 * project; the model's reply
 * is faked at `streamChat`, and the Tauri vector-store and embedding
 * commands are an in-memory store with a deterministic embedding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createFakeVectorStore, fakeEmbedding } from "@/test-helpers/fake-vector-store"

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeVectorStore> | null }))
const reply = vi.hoisted(() => ({ text: "" }))
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
  streamChat: vi.fn(async (_cfg: unknown, _messages: unknown, callbacks: {
    onToken: (t: string) => void
    onDone: (c?: { truncated?: boolean }) => void
  }) => {
    callbacks.onToken(reply.text)
    callbacks.onDone({})
  }),
}))

import { resetEmbeddingOptimizeAccountingForTests, searchByEmbedding } from "@/lib/embedding"
import { executeMerge, reembedMergedPages } from "./dedup-runner"
import { useWikiStore, type EmbeddingConfig, type LlmConfig } from "@/stores/wiki-store"

const embeddingConfig: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:1234/v1/embeddings",
  apiKey: "",
  model: "test-embedder",
}
const llmConfig = { provider: "ollama", apiKey: "", model: "qwen3:8b", ollamaUrl: "", customEndpoint: "", maxContextSize: 32000 } as LlmConfig
const group = { slugs: ["echo-loop", "echo-loops"], reason: "same topic", confidence: "high" as const }

let tmp: { path: string; cleanup: () => Promise<void> }
let fake: ReturnType<typeof createFakeVectorStore>

/** Front matter shaped like the live Agent Harness Wiki vault's pages. */
function page(title: string, body: string): string {
  return ["---", "type: concept", `title: ${title}`, "created: 2026-09-20", "sources: []", "---", body, ""].join("\n")
}

const row = (text: string) => [{ chunk_index: 0, chunk_text: text, heading_path: "", embedding: fakeEmbedding(text) }]
const upserted = () => fake.calls.filter((c) => c.cmd === "vector_upsert_chunks").map((c) => String(c.args.pageId))

beforeEach(async () => {
  tmp = await createTempProject("merge-reembed")
  fake = createFakeVectorStore()
  store.current = fake
  resetEmbeddingOptimizeAccountingForTests()
  written.paths = []
  useWikiStore.getState().setEmbeddingConfig(embeddingConfig)

  await writeFileRaw(`${tmp.path}/wiki/concepts/echo-loop.md`, page("Echo loop", "Peers suppress echoed replies."))
  await writeFileRaw(`${tmp.path}/wiki/concepts/echo-loops.md`, page("Echo loops", "Echoed replies loop between peers."))
  await writeFileRaw(`${tmp.path}/wiki/entities/relay.md`, page("Relay", "The relay guards against [[echo-loops]]."))
  await writeFileRaw(`${tmp.path}/wiki/entities/inbox.md`, page("Inbox", "The inbox holds messages."))
  fake.pages.set("concepts/echo-loop", row("Peers suppress echoed replies."))
  fake.pages.set("concepts/echo-loops", row("Echoed replies loop between peers."))
  fake.pages.set("entities/relay", row("The relay guards against echo loops."))
  fake.pages.set("entities/inbox", row("The inbox holds messages."))

  reply.text = page(
    "Echo loop",
    "Peers suppress echoed replies. Echoed replies loop between peers until a zebra quartz harmonic breaks them.",
  )
})

afterEach(async () => {
  useWikiStore.getState().setEmbeddingConfig({ enabled: false, endpoint: "", apiKey: "", model: "" })
  await tmp.cleanup()
})

describe("duplicate merge – vector index", () => {
  it("re-embeds the canonical page and each page whose links it rewrote, and removes the merged-away page's vectors", async () => {
    await reembedMergedPages(tmp.path, await executeMerge(tmp.path, group, "echo-loop", llmConfig))

    expect(upserted().sort()).toEqual(["concepts/echo-loop", "entities/relay"])
    expect([...fake.pages.keys()].sort()).toEqual(["concepts/echo-loop", "entities/inbox", "entities/relay"])
    const hits = await searchByEmbedding(tmp.path, "zebra quartz harmonic", embeddingConfig, 5)
    expect(hits[0]?.id).toBe("concepts/echo-loop")
  })

  it("writes the embedded-pages record once for all the pages it re-embeds", async () => {
    await reembedMergedPages(tmp.path, await executeMerge(tmp.path, group, "echo-loop", llmConfig))

    expect(upserted()).toHaveLength(2)
    expect(written.paths.filter((p) => p.endsWith("/.llm-wiki/embedded-pages.json"))).toHaveLength(1)
    const record = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`))
    expect(Object.keys(record).sort()).toEqual(["concepts/echo-loop", "entities/relay"])
  })

  it("removes the merged-away page's vectors inside the merge, before any re-embed", async () => {
    await executeMerge(tmp.path, group, "echo-loop", llmConfig)

    expect(upserted()).toEqual([])
    expect(fake.pages.has("concepts/echo-loops")).toBe(false)
  })

  it("removes the merged-away page's rows stored under its old bare slug", async () => {
    fake.pages.set("echo-loops", row("Echoed replies loop between peers."))

    await reembedMergedPages(tmp.path, await executeMerge(tmp.path, group, "echo-loop", llmConfig))

    expect(fake.pages.has("echo-loops")).toBe(false)
  })

  it("completes the merge with the embedding endpoint down, and records each failed embed", async () => {
    fake.state.endpointDown = true

    await reembedMergedPages(tmp.path, await executeMerge(tmp.path, group, "echo-loop", llmConfig))

    expect(await readFileRaw(`${tmp.path}/wiki/concepts/echo-loop.md`)).toContain("zebra quartz harmonic")
    expect(await fileExists(`${tmp.path}/wiki/concepts/echo-loops.md`)).toBe(false)
    expect(fake.pages.has("concepts/echo-loops")).toBe(false)
    const lines = (await readFileRaw(`${tmp.path}/.llm-wiki/embedding-failures.jsonl`)).trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.map((l) => [l.trigger, l.page])).toEqual([
      ["merge", "wiki/concepts/echo-loop.md"],
      ["merge", "wiki/entities/relay.md"],
    ])
  })

  it("embeds nothing while embeddings are off, and still removes the merged-away page's vectors", async () => {
    useWikiStore.getState().setEmbeddingConfig({ ...embeddingConfig, enabled: false })

    await reembedMergedPages(tmp.path, await executeMerge(tmp.path, group, "echo-loop", llmConfig))

    expect(upserted()).toEqual([])
    expect(fake.pages.has("concepts/echo-loops")).toBe(false)
  })
})
