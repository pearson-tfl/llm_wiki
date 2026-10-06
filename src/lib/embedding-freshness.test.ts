/**
 * Seam 2 of #67: the coverage check and backfill, against a real temporary
 * project on disk. The Tauri vector-store and embedding commands are
 * replaced by an in-memory store with a deterministic embedding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createFakeVectorStore, fakeEmbedding } from "@/test-helpers/fake-vector-store"
import { createDeferred, flushIO } from "@/test-helpers/deferred"

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeVectorStore> | null }))
const written = vi.hoisted(() => ({ paths: [] as string[] }))
/** While set, a file lookup ignores case, as on the Mac's file system. */
const lookup = vi.hoisted(() => ({ ignoresCase: false }))

vi.mock("@/commands/fs", () => ({
  ...realFs,
  writeFile: async (path: string, contents: string) => {
    written.paths.push(path)
    await realFs.writeFile(path, contents)
  },
  fileExists: async (path: string) => {
    if (!lookup.ignoresCase) return realFs.fileExists(path)
    const slash = path.lastIndexOf("/")
    const names = (await realFs.listDirectory(path.slice(0, slash))).map((n) => n.name.toLowerCase())
    return names.includes(path.slice(slash + 1).toLowerCase())
  },
}))
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => store.current!.invoke(cmd, args),
}))

import {
  embedPage,
  recordEmbeddedHashes,
  resetEmbeddingOptimizeAccountingForTests,
  searchByEmbedding,
} from "@/lib/embedding"
import { sha256 } from "@/lib/ingest-cache"
import {
  BACKFILL_STOP_AFTER_FAILURES,
  FAILURE_LOG_MAX_LINES,
  reembedWikiPages,
  removeWikiPageEmbeddings,
  runEmbeddingBackfill,
} from "./embedding-freshness"
import { useWikiStore, type EmbeddingConfig } from "@/stores/wiki-store"

const cfg: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:1234/v1/embeddings",
  apiKey: "",
  model: "test-embedder",
}

let tmp: { path: string; cleanup: () => Promise<void> }
let fake: ReturnType<typeof createFakeVectorStore>

/** Front matter shaped like the live Agent Harness Wiki vault's pages. */
function page(title: string, body: string): string {
  return [
    "---",
    "type: concept",
    `title: ${title}`,
    "created: 2026-09-20",
    "tags: [agent-to-agent]",
    "---",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n")
}

async function writePage(rel: string, content: string): Promise<void> {
  await writeFileRaw(`${tmp.path}/wiki/${rel}`, content)
}

function storedRow(text: string) {
  return [{ chunk_index: 0, chunk_text: text, heading_path: "", embedding: fakeEmbedding(text) }]
}

async function recordHashes(hashes: Record<string, string>): Promise<void> {
  await writeFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`, JSON.stringify(hashes))
}

async function recordedIds(): Promise<string[]> {
  return Object.keys(JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`))).sort()
}

async function upserted(): Promise<string[]> {
  return fake.calls.filter((c) => c.cmd === "vector_upsert_chunks").map((c) => String(c.args.pageId))
}

beforeEach(async () => {
  tmp = await createTempProject("embedding-freshness")
  fake = createFakeVectorStore()
  store.current = fake
  resetEmbeddingOptimizeAccountingForTests()
  written.paths = []
  lookup.ignoresCase = false
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("vector backfill – which pages it embeds", () => {
  it("embeds a page stored only under its bare slug, and removes the bare-slug rows", async () => {
    await writePage("concepts/echo-loop.md", page("Echo loop", "Peers suppress echoed replies."))
    fake.pages.set("echo-loop", storedRow("old text"))

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 1, failed: 0, orphansRemoved: 0 })
    expect([...fake.pages.keys()]).toEqual(["concepts/echo-loop"])
  })

  it("embeds a page with no vectors", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 1, failed: 0, orphansRemoved: 0 })
    expect(fake.pages.has("entities/relay")).toBe(true)
  })

  it("embeds a page whose recorded hash matches its file but whose vectors are gone", async () => {
    const content = page("Inbox", "The inbox holds messages.")
    await writePage("entities/inbox.md", content)
    await recordHashes({ "entities/inbox": await sha256(content) })

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 1, failed: 0, orphansRemoved: 0 })
    expect(fake.pages.has("entities/inbox")).toBe(true)
  })

  it("re-embeds a page whose file changed since it was embedded, so a search finds its new text", async () => {
    const before = page("Sweep", "The sweep runs nightly.")
    const after = page("Sweep", "The sweep now runs hourly with quartz scheduling.")
    await writePage("concepts/sweep.md", after)
    fake.pages.set("concepts/sweep", storedRow("The sweep runs nightly."))
    await recordHashes({ "concepts/sweep": await sha256(before) })

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 1, failed: 0, orphansRemoved: 0 })
    const hits = await searchByEmbedding(tmp.path, "quartz scheduling", cfg, 5)
    expect(hits[0]?.id).toBe("concepts/sweep")
  })

  it("re-embeds a page that has vectors but no recorded hash", async () => {
    await writePage("concepts/lock.md", page("Lock", "One writer at a time."))
    fake.pages.set("concepts/lock", storedRow("One writer at a time."))

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 1, failed: 0, orphansRemoved: 0 })
    expect(await upserted()).toEqual(["concepts/lock"])
  })

  it("leaves alone a page whose vectors match its file, a page with nothing to embed, and structural pages", async () => {
    const fresh = page("Fresh", "Already embedded.")
    await writePage("concepts/fresh.md", fresh)
    fake.pages.set("concepts/fresh", storedRow("Already embedded."))
    await recordHashes({ "concepts/fresh": await sha256(fresh) })
    await writePage("concepts/blank.md", "---\ntitle: Blank\n---\n")
    await writePage("index.md", page("Index", "Every page."))
    await writePage("log.md", page("Log", "Every change."))

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 2, covered: 2, embedded: 0, failed: 0, orphansRemoved: 0 })
    expect(await upserted()).toEqual([])
  })

  it("treats every page as changed when the embedded-pages record cannot be parsed, and rewrites it", async () => {
    const fresh = page("Fresh", "Already embedded.")
    await writePage("concepts/fresh.md", fresh)
    fake.pages.set("concepts/fresh", storedRow("Already embedded."))
    await writeFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`, "{not json")

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 1, failed: 0, orphansRemoved: 0 })
    const record = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`))
    expect(record["concepts/fresh"]).toBe(await sha256(fresh))
  })

  it("records the hash of each page it embeds, so the next run embeds nothing", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    await runEmbeddingBackfill(tmp.path, cfg)
    fake.calls.length = 0

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 0, failed: 0, orphansRemoved: 0 })
    expect(await upserted()).toEqual([])
    const record = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`))
    expect(record["entities/relay"]).toBe(await sha256(page("Relay", "The relay carries voice messages.")))
  })
})

describe("vector backfill – the per-run bound", () => {
  it("embeds at most the bound, pages with no vectors first, and leaves the rest for the next run", async () => {
    // Listed first, so only the priority puts it last.
    await writePage("concepts/a-stale.md", page("Stale", "Changed text."))
    fake.pages.set("concepts/a-stale", storedRow("Old text."))
    await writePage("concepts/missing-a.md", page("Missing A", "No vectors yet."))
    await writePage("concepts/missing-b.md", page("Missing B", "No vectors either."))

    const first = await runEmbeddingBackfill(tmp.path, cfg, 2)
    expect(first).toEqual({ pages: 3, covered: 2, embedded: 2, failed: 0, orphansRemoved: 0 })
    expect((await upserted()).sort()).toEqual(["concepts/missing-a", "concepts/missing-b"])

    fake.calls.length = 0
    const second = await runEmbeddingBackfill(tmp.path, cfg, 2)
    expect(second).toEqual({ pages: 3, covered: 3, embedded: 1, failed: 0, orphansRemoved: 0 })
    expect(await upserted()).toEqual(["concepts/a-stale"])
  })
})

describe("vector backfill – failures", () => {
  it("counts and records a page it could not embed, throws nothing, and tries it again next run", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    fake.state.endpointDown = true

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 0, embedded: 0, failed: 1, orphansRemoved: 0 })
    const lines = (await readFileRaw(`${tmp.path}/.llm-wiki/embedding-failures.jsonl`)).trim().split("\n")
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ trigger: "backfill", page: "wiki/entities/relay.md", reason: expect.stringContaining("connection refused") }),
    ])

    fake.state.endpointDown = false
    expect(await runEmbeddingBackfill(tmp.path, cfg)).toEqual({ pages: 1, covered: 1, embedded: 1, failed: 0, orphansRemoved: 0 })
  })

  it("does nothing while embeddings are off", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))

    expect(await runEmbeddingBackfill(tmp.path, { ...cfg, enabled: false })).toBeNull()
    expect(fake.calls).toEqual([])
  })
})

describe("vector backfill – an endpoint that is down (#73)", () => {
  it("stops after a short run of failed embeds, and records why", async () => {
    for (let i = 0; i < 12; i++) {
      await writePage(`concepts/page-${String(i).padStart(2, "0")}.md`, page(`Page ${i}`, `Body of page ${i}.`))
    }
    fake.state.endpointDown = true

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({
      pages: 12,
      covered: 0,
      embedded: 0,
      failed: BACKFILL_STOP_AFTER_FAILURES,
      orphansRemoved: 0,
      stoppedEarly: expect.stringMatching(/^stopped after 5 failed embeds in a row: .*connection refused/),
    })
    const lines = (await readFileRaw(`${tmp.path}/.llm-wiki/embedding-failures.jsonl`)).trim().split("\n")
    expect(lines).toHaveLength(BACKFILL_STOP_AFTER_FAILURES)
  })

  it("carries on past a run of pages the endpoint refuses while the endpoint itself answers", async () => {
    // Listed first, so without the endpoint check they would stop every run.
    for (let i = 0; i < BACKFILL_STOP_AFTER_FAILURES + 1; i++) {
      await writePage(`concepts/a-bad-${i}.md`, page(`Bad ${i}`, `Poison text ${i}.`))
    }
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    await writePage("entities/inbox.md", page("Inbox", "The inbox holds messages."))
    fake.state.rejecting = "Poison"

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 8, covered: 2, embedded: 2, failed: 6, orphansRemoved: 0 })
    expect(fake.pages.has("entities/relay")).toBe(true)
    expect(fake.pages.has("entities/inbox")).toBe(true)
  })

  it("keeps only the newest lines of the failures file", async () => {
    const old = Array.from({ length: FAILURE_LOG_MAX_LINES }, (_, n) => JSON.stringify({ n })).join("\n")
    await writeFileRaw(`${tmp.path}/.llm-wiki/embedding-failures.jsonl`, `${old}\n`)
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    fake.state.endpointDown = true

    await runEmbeddingBackfill(tmp.path, cfg)

    const lines = (await readFileRaw(`${tmp.path}/.llm-wiki/embedding-failures.jsonl`)).trim().split("\n").map((l) => JSON.parse(l))
    expect(lines).toHaveLength(FAILURE_LOG_MAX_LINES)
    expect(lines[0]).toEqual({ n: 1 })
    expect(lines[lines.length - 1]).toEqual(expect.objectContaining({ trigger: "backfill", page: "wiki/entities/relay.md" }))
  })
})

describe("vector backfill – vectors of pages that are gone (#73)", () => {
  it("removes the vectors of a page deleted since the last run", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    await writePage("entities/inbox.md", page("Inbox", "The inbox holds messages."))
    await runEmbeddingBackfill(tmp.path, cfg)
    await realFs.deleteFile(`${tmp.path}/wiki/entities/inbox.md`)

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 0, failed: 0, orphansRemoved: 1 })
    expect([...fake.pages.keys()]).toEqual(["entities/relay"])
  })

  it("keeps a bare-slug row whose name a page still owns, and removes one no page owns", async () => {
    await writePage("concepts/echo-loop.md", page("Echo loop", "Peers suppress echoed replies."))
    fake.pages.set("echo-loop", storedRow("old text"))
    fake.pages.set("gone-slug", storedRow("old text"))

    // No embeds this run, so only the sweep can touch the rows.
    const coverage = await runEmbeddingBackfill(tmp.path, cfg, 0)

    expect(coverage?.orphansRemoved).toBe(1)
    expect([...fake.pages.keys()]).toEqual(["echo-loop"])
  })

  it("removes nothing when the wiki lists no content pages", async () => {
    fake.pages.set("entities/relay", storedRow("The relay carries voice messages."))

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 0, covered: 0, embedded: 0, failed: 0, orphansRemoved: 0 })
    expect(fake.pages.has("entities/relay")).toBe(true)
  })
})

describe("vector backfill – the embedded-pages record (#73)", () => {
  it("is written once per run, with every page it embedded", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    await writePage("entities/inbox.md", page("Inbox", "The inbox holds messages."))
    await writePage("concepts/sweep.md", page("Sweep", "The sweep runs nightly."))

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage?.embedded).toBe(3)
    expect(written.paths.filter((p) => p.endsWith("/.llm-wiki/embedded-pages.json"))).toHaveLength(1)
    const record = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`))
    expect(Object.keys(record).sort()).toEqual(["concepts/sweep", "entities/inbox", "entities/relay"])
  })
})

describe("vector backfill – recorded hashes of pages that are gone (#80)", () => {
  it("removes the recorded hash of a page deleted since the last run", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    await writePage("entities/inbox.md", page("Inbox", "The inbox holds messages."))
    await runEmbeddingBackfill(tmp.path, cfg)
    expect(await recordedIds()).toEqual(["entities/inbox", "entities/relay"])
    await realFs.deleteFile(`${tmp.path}/wiki/entities/inbox.md`)

    await runEmbeddingBackfill(tmp.path, cfg)

    expect(await recordedIds()).toEqual(["entities/relay"])
  })

  it("keeps the recorded hash of an id differing only in case from a page, whose file the Mac still finds", async () => {
    lookup.ignoresCase = true
    const content = page("Relay", "The relay carries voice messages.")
    await writePage("entities/relay.md", content)
    fake.pages.set("entities/relay", storedRow(content))
    fake.pages.set("entities/Relay", storedRow(content))
    await recordHashes({ "entities/relay": await sha256(content), "entities/Relay": await sha256(content) })

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage?.orphansRemoved).toBe(0)
    expect(await recordedIds()).toEqual(["entities/Relay", "entities/relay"])
  })

  it("keeps the recorded hash of a gone page whose vectors could not be removed", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    await writePage("entities/inbox.md", page("Inbox", "The inbox holds messages."))
    await runEmbeddingBackfill(tmp.path, cfg)
    await realFs.deleteFile(`${tmp.path}/wiki/entities/inbox.md`)
    store.current = {
      ...fake,
      invoke: (cmd: string, args?: Record<string, unknown>) =>
        cmd === "vector_delete_page" ? Promise.reject(new Error("table locked")) : fake.invoke(cmd, args),
    }

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage?.orphansRemoved).toBe(0)
    expect(await recordedIds()).toEqual(["entities/inbox", "entities/relay"])
  })
})

describe("vector backfill – recorded hashes pruned by the record's own ids (#82)", () => {
  it("removes the recorded hash of a page that has neither vectors nor a file", async () => {
    const content = page("Relay", "The relay carries voice messages.")
    await writePage("entities/relay.md", content)
    fake.pages.set("entities/relay", storedRow(content))
    // Left by a delete before #80, which removed the vectors only.
    await recordHashes({ "entities/relay": await sha256(content), "entities/inbox": await sha256("old inbox text") })

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage).toEqual({ pages: 1, covered: 1, embedded: 0, failed: 0, orphansRemoved: 0 })
    expect(await recordedIds()).toEqual(["entities/relay"])
  })

  it("removes the recorded hash of a page a merge deleted", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    await writePage("entities/inbox.md", page("Inbox", "The inbox holds messages."))
    await runEmbeddingBackfill(tmp.path, cfg)
    // The merge removes the merged-away page's vectors, then its file.
    await removeWikiPageEmbeddings(tmp.path, ["wiki/entities/inbox.md"])
    await realFs.deleteFile(`${tmp.path}/wiki/entities/inbox.md`)
    expect(await recordedIds()).toEqual(["entities/inbox", "entities/relay"])

    await runEmbeddingBackfill(tmp.path, cfg)

    expect(await recordedIds()).toEqual(["entities/relay"])
  })

  it("keeps the recorded hash of an id with no vectors differing only in case from a page, whose file the Mac still finds", async () => {
    lookup.ignoresCase = true
    const content = page("Relay", "The relay carries voice messages.")
    await writePage("entities/relay.md", content)
    fake.pages.set("entities/relay", storedRow(content))
    await recordHashes({ "entities/relay": await sha256(content), "entities/Relay": await sha256(content) })

    await runEmbeddingBackfill(tmp.path, cfg)

    expect(await recordedIds()).toEqual(["entities/Relay", "entities/relay"])
  })

  it("keeps every recorded hash when the wiki lists no content pages", async () => {
    await recordHashes({ "entities/inbox": await sha256("old inbox text") })

    await runEmbeddingBackfill(tmp.path, cfg)

    expect(await recordedIds()).toEqual(["entities/inbox"])
  })

  it("keeps the recorded hash of a page whose vectors land again after its old ones are removed", async () => {
    await writePage("entities/relay.md", page("Relay", "The relay carries voice messages."))
    await writePage("entities/inbox.md", page("Inbox", "The inbox holds messages."))
    await runEmbeddingBackfill(tmp.path, cfg)
    await realFs.deleteFile(`${tmp.path}/wiki/entities/inbox.md`)
    // An ingest writes the page again, and embeds it, just after the
    // backfill removes its old vectors.
    const rewritten = page("Inbox", "The inbox now queues voice notes.")
    let relanded = false
    store.current = {
      ...fake,
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        const out = await fake.invoke(cmd, args)
        if (cmd === "vector_delete_page" && args?.pageId === "entities/inbox" && !relanded) {
          relanded = true
          await writePage("entities/inbox.md", rewritten)
          expect(await embedPage(tmp.path, "entities/inbox", "Inbox", rewritten, cfg)).toBe(true)
        }
        return out
      },
    }

    await runEmbeddingBackfill(tmp.path, cfg)

    expect(relanded).toBe(true)
    expect(fake.pages.get("entities/inbox")?.[0].chunk_text).toContain("queues voice notes")
    const record = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`))
    expect(record["entities/inbox"]).toBe(await sha256(rewritten))
  })
})

describe("vector backfill – two writers on one page (#73 gate)", () => {
  afterEach(() => {
    useWikiStore.getState().setEmbeddingConfig({ enabled: false, endpoint: "", apiKey: "", model: "" })
  })

  it("repairs a page whose older embed landed after a newer one and whose newer hash was recorded last", async () => {
    useWikiStore.getState().setEmbeddingConfig(cfg)
    const v1 = page("Lease", "The lease runs a year.")
    const v2 = page("Lease", "The lease now runs on quartz monthly terms.")
    await writePage("concepts/lease.md", v1)
    const endpoint = createDeferred<void>()
    fake.state.hung = { matching: "runs a year", until: endpoint.promise }

    // The merge's re-embed reads the page as v1, and its embed waits on the
    // endpoint.
    const merge = reembedWikiPages(tmp.path, ["wiki/concepts/lease.md"], "merge")
    for (let i = 0; i < 200 && !fake.calls.some((c) => JSON.stringify(c.args).includes("runs a year")); i++) await flushIO()
    // An ingest writes v2 and stores its vectors; its batch records the
    // hash later.
    await writePage("concepts/lease.md", v2)
    const ingestBatch: Parameters<typeof recordEmbeddedHashes>[1] = {}
    expect(await embedPage(tmp.path, "concepts/lease", "Lease", v2, cfg, { hashes: ingestBatch })).toBe(true)
    // The merge's slow embed lands over them, and its batch records v1.
    endpoint.resolve()
    fake.state.hung = null
    expect(await merge).toBe(0)
    // The ingest's longer batch records v2 last.
    await recordEmbeddedHashes(tmp.path, ingestBatch)
    expect(fake.pages.get("concepts/lease")?.[0].chunk_text).toContain("runs a year")

    const coverage = await runEmbeddingBackfill(tmp.path, cfg)

    expect(coverage?.embedded).toBe(1)
    expect(fake.pages.get("concepts/lease")?.[0].chunk_text).toContain("quartz monthly terms")
    const hits = await searchByEmbedding(tmp.path, "quartz monthly terms", cfg, 5)
    expect(hits[0]?.id).toBe("concepts/lease")
    const record = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`))
    expect(record["concepts/lease"]).toBe(await sha256(v2))
  })
})
