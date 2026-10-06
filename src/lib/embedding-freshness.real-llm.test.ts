/**
 * The #73 follow-ups on a real embedding endpoint. The merge queue, the
 * ingest queue, `executeMerge`, `autoIngest` and the backfill are real and
 * write a real temporary project; the model's replies are scripted, and the
 * vector store is the in-memory store (LanceDB is not reachable under
 * Node). Every embedding goes over HTTP: to the real endpoint, through a
 * local relay that never answers a request holding the merged page's text,
 * or to a port with nothing listening.
 *
 * Gated behind RUN_LLM_TESTS=1, EMBEDDING_ENDPOINT and EMBEDDING_MODEL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"
import { ingestScenarios } from "@/test-helpers/scenarios/ingest-scenarios"

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeVectorStore> | null }))
const written = vi.hoisted(() => ({ paths: [] as string[] }))
const model = vi.hoisted(() => ({ mergeReply: "", ingestReplies: [] as string[] }))

vi.mock("@/commands/fs", () => ({
  ...realFs,
  writeFile: async (path: string, contents: string) => {
    written.paths.push(path)
    await realFs.writeFile(path, contents)
  },
}))

const PROJECT_ID = "freshness-real-project"
const registry = vi.hoisted(() => ({ path: "" }))
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => (id === "freshness-real-project" ? registry.path : null)),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

/** POST to the endpoint as the app's Rust command does, OpenAI-shaped. */
async function realEmbeddings(input: string | string[], cfg: { endpoint: string; model: string }): Promise<number[][]> {
  const response = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input }),
  })
  if (!response.ok) throw new Error(`embedding endpoint answered ${response.status}`)
  return ((await response.json()).data as { embedding: number[] }[]).map((d) => d.embedding)
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    const cfg = args.cfg as { endpoint: string; model: string }
    if (cmd === "embedding_fetch") return (await realEmbeddings(String(args.text), cfg))[0]
    if (cmd === "embedding_fetch_batch") return realEmbeddings(args.texts as string[], cfg)
    return store.current!.invoke(cmd, args)
  },
}))

vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages: { content: string }[], cb) => {
    const system = messages[0]?.content ?? ""
    cb.onToken(system.includes("Merge them into a single coherent wiki page") ? model.mergeReply : model.ingestReplies.shift() ?? "")
    cb.onDone()
  }),
}))

import * as dedupQueue from "./dedup-queue"
import * as ingestQueue from "./ingest-queue"
import { resetEmbeddingOptimizeAccountingForTests } from "./embedding"
import { BACKFILL_STOP_AFTER_FAILURES, runEmbeddingBackfill } from "./embedding-freshness"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type EmbeddingConfig } from "@/stores/wiki-store"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1" &&
  !!process.env.EMBEDDING_ENDPOINT &&
  !!process.env.EMBEDDING_MODEL

const scenario = ingestScenarios.find((s) => s.name === "basic-new-source")!
const MERGED_MARKER = "In the transformer it is scaled dot-product attention"

function concept(title: string, body: string): string {
  return ["---", "type: concept", `title: ${title}`, "created: 2026-10-06", "updated: 2026-10-06", "tags: []", "related: []", "sources: []", "---", `# ${title}`, "", body, ""].join("\n")
}

/** A relay to the real endpoint that never answers a request holding
 *  `marker`, as an endpoint that accepts the connection and hangs. */
async function startRelay(target: string, marker: string): Promise<{ url: string; held: () => number; close: () => Promise<void> }> {
  let held = 0
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", async () => {
      if (body.includes(marker)) {
        held++
        return
      }
      const upstream = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body })
      res.writeHead(upstream.status, { "Content-Type": "application/json" })
      res.end(await upstream.text())
    })
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/embeddings`,
    held: () => held,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** An address with nothing listening: a stopped endpoint. */
async function stoppedEndpoint(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}/v1/embeddings`
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, limitMs = 60_000): Promise<void> {
  const deadline = Date.now() + limitMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`waitUntil: not true within ${limitMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe.skipIf(!ENABLED)("vector freshness on a real embedding endpoint (#73)", () => {
  const cfg: EmbeddingConfig = {
    enabled: true,
    endpoint: process.env.EMBEDDING_ENDPOINT ?? "",
    apiKey: "",
    model: process.env.EMBEDDING_MODEL ?? "",
  }
  let tmp: { path: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    tmp = await createTempProject("freshness-real")
    registry.path = tmp.path
    store.current = createFakeVectorStore()
    written.paths = []
    resetEmbeddingOptimizeAccountingForTests()
  })

  afterEach(async () => {
    ingestQueue.clearQueueState()
    dedupQueue.clearQueueState()
    useWikiStore.getState().setEmbeddingConfig({ enabled: false, endpoint: "", apiKey: "", model: "" })
    await tmp.cleanup()
  })

  it("an ingest writes its pages while a merge's re-embed waits on an endpoint that never answers", async () => {
    const relay = await startRelay(cfg.endpoint, MERGED_MARKER)
    try {
      for (const [rel, content] of Object.entries(scenario.initialWiki)) await writeFileRaw(`${tmp.path}/${rel}`, content)
      await writeFileRaw(`${tmp.path}/${scenario.source.path}`, scenario.source.content)
      await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n\n## Concepts\n- [[attention]]\n- [[transformer-attention]]\n")
      await writeFileRaw(`${tmp.path}/wiki/concepts/attention.md`, concept("Attention", "Attention weighs every token against every other token."))
      await writeFileRaw(`${tmp.path}/wiki/concepts/transformer-attention.md`, concept("Transformer Attention", "Scaled dot-product attention over queries, keys and values."))
      model.mergeReply = concept("Attention", `Attention weighs every token against every other token. ${MERGED_MARKER} over queries, keys and values.`)
      model.ingestReplies = [scenario.analysisResponse, scenario.generationResponse]
      useWikiStore.getState().setProject({ id: PROJECT_ID, name: "t", path: tmp.path })
      useWikiStore.getState().setLlmConfig({ provider: "openai", apiKey: "test-key", model: "gpt-4", ollamaUrl: "", customEndpoint: "", maxContextSize: 128000 })
      useWikiStore.getState().setEmbeddingConfig({ ...cfg, endpoint: relay.url })
      useReviewStore.getState().setItems([])
      ingestQueue.clearQueueState()
      dedupQueue.clearQueueState()
      await ingestQueue.restoreQueue(PROJECT_ID, tmp.path)
      await dedupQueue.restoreQueue(PROJECT_ID, tmp.path)

      await dedupQueue.enqueueMerge(PROJECT_ID, { slugs: ["attention", "transformer-attention"], reason: "same", confidence: "high" }, "attention")
      await waitUntil(() => relay.held() > 0)
      console.log(`[#73 live] merge written; re-embed held by the relay (${relay.held()} request(s) unanswered)`)

      const started = Date.now()
      await ingestQueue.enqueueIngest(PROJECT_ID, scenario.source.path)
      await waitUntil(async () => (await readFileRaw(`${tmp.path}/wiki/index.md`)).includes("rope"))
      console.log(`[#73 live] ingest wrote rope.md and its index line ${Date.now() - started} ms after enqueue; merge task still ${dedupQueue.getQueue()[0]?.status}`)
      expect(await fileExists(`${tmp.path}/wiki/concepts/rope.md`)).toBe(true)
      expect(dedupQueue.getQueue().map((t) => t.status)).toEqual(["processing"])
      // The ingest's own embeds go through the relay and are answered.
      await waitUntil(() => ingestQueue.getQueue().length === 0)
      expect([...store.current!.pages.keys()].filter((id) => id !== "concepts/attention").sort()).toEqual([
        "concepts/rope",
        "sources/rope-paper",
      ])
    } finally {
      await relay.close()
    }
    await waitUntil(() => dedupQueue.getQueue().length === 0)
    const failures = (await readFileRaw(`${tmp.path}/.llm-wiki/embedding-failures.jsonl`)).trim().split("\n").map((l) => JSON.parse(l))
    console.log(`[#73 live] after the relay closed, the merge finished; failures file: ${JSON.stringify(failures.map((f) => [f.trigger, f.page]))}`)
    expect(failures[0]).toEqual(expect.objectContaining({ trigger: "merge", page: "wiki/concepts/attention.md" }))
  }, 120_000)

  it("with the endpoint stopped, the backfill stops after a short run of failures and records why", async () => {
    for (let i = 0; i < 12; i++) await writeFileRaw(`${tmp.path}/wiki/concepts/page-${i}.md`, concept(`Page ${i}`, `Body of page ${i}.`))

    const coverage = await runEmbeddingBackfill(tmp.path, { ...cfg, endpoint: await stoppedEndpoint() })

    console.log(`[#73 live] stopped endpoint: vectorCoverage ${JSON.stringify(coverage)}`)
    expect(coverage?.failed).toBe(BACKFILL_STOP_AFTER_FAILURES)
    expect(coverage?.stoppedEarly).toMatch(/^stopped after 5 failed embeds in a row: /)
    const lines = (await readFileRaw(`${tmp.path}/.llm-wiki/embedding-failures.jsonl`)).trim().split("\n")
    console.log(`[#73 live] failures file: ${lines.length} lines`)
    expect(lines).toHaveLength(BACKFILL_STOP_AFTER_FAILURES)
  }, 60_000)

  it("embeds on the real endpoint with one record write, and the next run removes a deleted page's vectors", async () => {
    await writeFileRaw(`${tmp.path}/wiki/entities/relay.md`, concept("Relay", "The relay carries voice messages."))
    await writeFileRaw(`${tmp.path}/wiki/entities/inbox.md`, concept("Inbox", "The inbox holds messages."))
    await writeFileRaw(`${tmp.path}/wiki/concepts/sweep.md`, concept("Sweep", "The sweep runs nightly."))

    const first = await runEmbeddingBackfill(tmp.path, cfg)
    const recordWrites = written.paths.filter((p) => p.endsWith("/.llm-wiki/embedded-pages.json")).length
    console.log(`[#73 live] first run: vectorCoverage ${JSON.stringify(first)}; embedded-pages.json writes: ${recordWrites}`)
    expect(first?.embedded).toBe(3)
    expect(recordWrites).toBe(1)

    await realFs.deleteFile(`${tmp.path}/wiki/entities/inbox.md`)
    const second = await runEmbeddingBackfill(tmp.path, cfg)
    console.log(`[#73 live] after deleting inbox.md: vectorCoverage ${JSON.stringify(second)}; stored ids ${JSON.stringify([...store.current!.pages.keys()].sort())}`)
    expect(second?.orphansRemoved).toBe(1)
    expect([...store.current!.pages.keys()].sort()).toEqual(["concepts/sweep", "entities/relay"])
  }, 60_000)
})
