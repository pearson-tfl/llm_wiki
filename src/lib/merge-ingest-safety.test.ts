/**
 * Seam 2 of #24: the duplicate-merge queue and the ingest queue against a
 * real temporary project, with the model faked at streamChat. The merge
 * queue, executeMerge, the ingest queue and autoIngest are all real, so
 * the writes that race are the ones the app makes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { createTempProject, fileExists, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createDeferred, flushIO, waitFor, type Deferred } from "@/test-helpers/deferred"
import { ingestScenarios } from "@/test-helpers/scenarios/ingest-scenarios"

vi.mock("@/commands/fs", () => realFs)

const PROJECT_ID = "merge-safety-project"
const registry = vi.hoisted(() => ({ path: "" }))
vi.mock("@/lib/project-identity", () => ({
  ensureProjectId: vi.fn(),
  upsertProjectInfo: vi.fn(),
  getProjectPathById: vi.fn(async (id: string) => (id === "merge-safety-project" ? registry.path : null)),
  getProjectIdByPath: vi.fn(),
  loadRegistry: vi.fn(),
}))

/** The model: merge calls are told apart from ingest calls by the merge
 *  system prompt. Each test sets the replies. */
const model = vi.hoisted(() => ({
  mergeCalls: 0,
  mergeReply: null as null | (() => Promise<string>),
  ingestCalls: 0,
  ingestReplies: [] as (() => Promise<string>)[],
}))
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages: { role: string; content: string }[], cb) => {
    const system = messages[0]?.content ?? ""
    let reply = ""
    if (system.includes("Merge them into a single coherent wiki page")) {
      model.mergeCalls += 1
      reply = model.mergeReply ? await model.mergeReply() : ""
    } else {
      model.ingestCalls += 1
      const next = model.ingestReplies.shift()
      reply = next ? await next() : ""
    }
    cb.onToken(reply)
    cb.onDone()
  }),
}))

import * as dedupQueue from "./dedup-queue"
import * as ingestQueue from "./ingest-queue"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import { withProjectLock } from "./project-mutex"
import type { DuplicateGroup } from "./dedup"

const scenario = ingestScenarios.find((s) => s.name === "basic-new-source")!

const INDEX = [
  "# Index",
  "",
  "## Concepts",
  "- [[attention]]",
  "- [[transformer-attention]]",
  "",
].join("\n")

function concept(title: string, body: string): string {
  return [
    "---",
    "type: concept",
    `title: ${title}`,
    "created: 2026-09-01",
    "updated: 2026-09-01",
    "tags: [attention]",
    "related: []",
    `sources: ["${title.toLowerCase().replace(/ /g, "-")}.md"]`,
    "---",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n")
}

const ATTENTION = concept(
  "Attention",
  "Attention weighs every token in a sequence against every other token to build context.",
)
const TRANSFORMER_ATTENTION = concept(
  "Transformer Attention",
  "Transformer attention is scaled dot-product attention over queries, keys and values.",
)
const MERGED = concept(
  "Attention",
  [
    "Attention weighs every token in a sequence against every other token to build context.",
    "In the transformer it is scaled dot-product attention over queries, keys and values.",
  ].join("\n"),
)

const GROUP: DuplicateGroup = {
  slugs: ["attention", "transformer-attention"],
  reason: "same concept",
  confidence: "high",
}

let tmp: { path: string; cleanup: () => Promise<void> }

function reply(text: string): () => Promise<string> {
  return async () => text
}

function held(deferred: Deferred<string>): () => Promise<string> {
  return () => deferred.promise
}

async function read(rel: string): Promise<string> {
  return readFileRaw(`${tmp.path}/${rel}`)
}

async function bothQueuesIdle(): Promise<boolean> {
  return dedupQueue.getQueue().length === 0 && ingestQueue.getQueue().length === 0
}

beforeEach(async () => {
  tmp = await createTempProject("merge-safety")
  registry.path = tmp.path
  for (const [rel, content] of Object.entries(scenario.initialWiki)) {
    await writeFileRaw(`${tmp.path}/${rel}`, content)
  }
  await writeFileRaw(`${tmp.path}/${scenario.source.path}`, scenario.source.content)
  await writeFileRaw(`${tmp.path}/wiki/index.md`, INDEX)
  await writeFileRaw(`${tmp.path}/wiki/concepts/attention.md`, ATTENTION)
  await writeFileRaw(`${tmp.path}/wiki/concepts/transformer-attention.md`, TRANSFORMER_ATTENTION)

  model.mergeCalls = 0
  model.mergeReply = null
  model.ingestCalls = 0
  model.ingestReplies = []

  useWikiStore.getState().setProject({ id: PROJECT_ID, name: "t", path: tmp.path })
  useWikiStore.getState().setLlmConfig({
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "",
    customEndpoint: "",
    maxContextSize: 128000,
  })
  useReviewStore.getState().setItems([])

  ingestQueue.clearQueueState()
  dedupQueue.clearQueueState()
  await ingestQueue.restoreQueue(PROJECT_ID, tmp.path)
  await dedupQueue.restoreQueue(PROJECT_ID, tmp.path)
})

afterEach(async () => {
  vi.useRealTimers()
  ingestQueue.clearQueueState()
  dedupQueue.clearQueueState()
  await tmp.cleanup()
})

describe("ingest and the duplicate merge never write at once (#24)", () => {
  it("an ingest that reaches its write during a merge waits, and its index addition survives", async () => {
    const mergeReply = createDeferred<string>()
    model.mergeReply = held(mergeReply)
    model.ingestReplies = [reply(scenario.analysisResponse), reply(scenario.generationResponse)]

    await dedupQueue.enqueueMerge(PROJECT_ID, GROUP, "attention")
    await waitFor(() => model.mergeCalls === 1)

    // The merge has read every page and waits on the model. Ingest a
    // source now: its preparation runs, and it reaches its write.
    await ingestQueue.enqueueIngest(PROJECT_ID, scenario.source.path)
    await waitFor(() => model.ingestCalls === 2)
    await flushIO(50)
    expect(await read("wiki/index.md")).toBe(INDEX)

    mergeReply.resolve(MERGED)
    await waitFor(bothQueuesIdle, 500)

    const index = await read("wiki/index.md")
    expect(index).toContain("rope")
    expect(index).not.toContain("transformer-attention")
    expect(await fileExists(`${tmp.path}/wiki/concepts/rope.md`)).toBe(true)
    expect(await fileExists(`${tmp.path}/wiki/concepts/transformer-attention.md`)).toBe(false)
    expect(await read("wiki/concepts/attention.md")).toContain("scaled dot-product")
  })

  it("starts no merge while ingest runs, and carries on with no click once ingest is idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const analysis = createDeferred<string>()
    model.ingestReplies = [held(analysis), reply(scenario.generationResponse)]
    model.mergeReply = reply(MERGED)

    await ingestQueue.enqueueIngest(PROJECT_ID, scenario.source.path)
    await waitFor(() => model.ingestCalls === 1)

    await dedupQueue.enqueueMerge(PROJECT_ID, GROUP, "attention")
    await flushIO(20)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(model.mergeCalls).toBe(0)
    expect(dedupQueue.getQueue().map((t) => t.status)).toEqual(["pending"])

    analysis.resolve(scenario.analysisResponse)
    await waitFor(() => ingestQueue.getQueue().length === 0, 500)
    expect(model.mergeCalls).toBe(0)

    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => dedupQueue.getQueue().length === 0, 500)
    expect(model.mergeCalls).toBe(1)
    expect(await fileExists(`${tmp.path}/wiki/concepts/transformer-attention.md`)).toBe(false)
    expect(await read("wiki/index.md")).toContain("rope")
  })

  it("re-checks ingest once it holds the write lock, and hands the turn back if ingest started during the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const analysis = createDeferred<string>()
    model.ingestReplies = [held(analysis), reply(scenario.generationResponse)]
    model.mergeReply = reply(MERGED)

    // Another writer (Save to Wiki, say) holds the project write lock, so
    // the merge waits for it after passing its first ingest check.
    const otherWriter = createDeferred<void>()
    const otherWrite = withProjectLock(tmp.path, () => otherWriter.promise)
    await dedupQueue.enqueueMerge(PROJECT_ID, GROUP, "attention")
    await waitFor(() => dedupQueue.getQueue()[0]?.status === "processing")

    // Ingest starts during that wait.
    await ingestQueue.enqueueIngest(PROJECT_ID, scenario.source.path)
    await waitFor(() => model.ingestCalls === 1)
    otherWriter.resolve()
    await otherWrite
    await waitFor(() => dedupQueue.getQueue()[0]?.status === "pending")
    expect(model.mergeCalls).toBe(0)

    analysis.resolve(scenario.analysisResponse)
    await waitFor(() => ingestQueue.getQueue().length === 0, 500)
    await vi.advanceTimersByTimeAsync(60_000)
    await waitFor(() => dedupQueue.getQueue().length === 0, 500)
    expect(model.mergeCalls).toBe(1)
    expect(await read("wiki/index.md")).toContain("rope")
    expect(await read("wiki/index.md")).not.toContain("transformer-attention")
  })
})

describe("a merge reply that fails the guard changes nothing (#24)", () => {
  it.each([
    ["empty", ""],
    ["much shorter than the canonical page", concept("Attention", "Short.")],
    ["missing frontmatter", MERGED.split("---\n").slice(2).join("---\n")],
  ])("rejects a reply that is %s: no page changed or deleted, rejection recorded", async (_label, text) => {
    model.mergeReply = reply(text)
    const before = new Map<string, string>()
    for (const rel of ["wiki/index.md", "wiki/concepts/attention.md", "wiki/concepts/transformer-attention.md"]) {
      before.set(rel, await read(rel))
    }

    const taskId = await dedupQueue.enqueueMerge(PROJECT_ID, GROUP, "attention", { scheduled: true })
    expect(await dedupQueue.waitForTask(taskId)).toBe("rejected")

    for (const [rel, content] of before) expect(await read(rel)).toBe(content)
    const history = await fs.readdir(`${tmp.path}/.llm-wiki/page-history`).catch(() => [])
    expect(history).toEqual([])
    // A rejection is final: the model is not asked again.
    await flushIO(20)
    expect(model.mergeCalls).toBe(1)

    const [task] = dedupQueue.getQueue()
    expect(task.status).toBe("failed")
    expect(task.error).toMatch(/Merge reply rejected/)

    const items = useReviewStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: "duplicate",
      resolved: false,
      affectedPages: ["attention.md", "transformer-attention.md"],
    })
    expect(items[0].title).toContain("attention, transformer-attention")
    expect(items[0].description).toContain(task.error)
  })
})
