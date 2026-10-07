/**
 * A detector call that fails mid-scan (#118), and calls that keep failing
 * (#124), end to end on a copy of a real vault: the real
 * runDuplicateDetection and the real scheduled runMaintenanceTick, with the
 * real embedding endpoint and the app's real HTTP model client. The model
 * endpoint is a local server on the scheduled route's wire (`custom`,
 * Anthropic messages), scripted per case: for #118 its second call answers
 * HTTP 429 and its fourth drops the connection; for #124 every call from the
 * second answers 429. Every other call answers one medium-confidence group,
 * so the scheduled run merges nothing. The Tauri
 * layer is replaced as in #112's live test: files through node:fs,
 * embeddings by a direct call to the endpoint, the settings store in memory.
 *
 * The first DEDUP_PAGES entity and concept pages of the copy (default 600)
 * are copied to a fresh project, so the vault copy is only read.
 *
 * Gated behind RUN_LLM_TESTS=1, EMBEDDING_ENDPOINT, EMBEDDING_MODEL and
 * DEDUP_VAULT_COPY; DEDUP_PAGES sets the page count. Writes its
 * measurements to `<DEDUP_REPORT>.model-error.json` (#118) and
 * `<DEDUP_REPORT>.stop.json` (#124) when DEDUP_REPORT is set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import http from "node:http"
import type { AddressInfo } from "node:net"
import path from "node:path"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"
import { useWikiStore, type EmbeddingConfig, type LlmConfig } from "@/stores/wiki-store"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1"
  && !!process.env.EMBEDDING_ENDPOINT
  && !!process.env.EMBEDDING_MODEL
  && !!process.env.DEDUP_VAULT_COPY

const storage = vi.hoisted(() => new Map<string, unknown>())
/** The pages the prefilter paired, per scan. */
const paired = vi.hoisted(() => ({ pages: new Set<string>() }))

vi.mock("@/commands/fs", () => realFs)

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => storage.get(key),
    set: async (key: string, value: unknown) => {
      storage.set(key, value)
    },
    delete: async (key: string) => {
      storage.delete(key)
    },
    save: async () => undefined,
  }),
}))

vi.mock("@/lib/dedup_embedding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dedup_embedding")>()
  return {
    ...actual,
    candidatePairs: async (...args: Parameters<typeof actual.candidatePairs>) => {
      const pairs = await actual.candidatePairs(...args)
      paired.pages = new Set(pairs.flat())
      return pairs
    },
  }
})

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>()
  return {
    ...actual,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "embedding_fetch") {
        const cfg = args?.cfg as { endpoint: string; model: string }
        const response = await fetch(cfg.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: cfg.model, input: String(args?.text) }),
        })
        if (!response.ok) throw new Error(`embedding endpoint answered ${response.status}`)
        return (await response.json()).data[0].embedding
      }
      throw new Error(`unexpected invoke ${cmd}`)
    },
  }
})

/** What the model endpoint did with each call, in order. */
interface ModelCall {
  pages: number
  /** Pages in the call that the prefilter paired with none. */
  unpaired: number
  outcome: "answered" | "http-429" | "connection-dropped"
}

const calls: ModelCall[] = []
/** Where the current scan's calls start in `calls`. */
let scanStart = 0
let server: http.Server
/** How the current case's endpoint treats each scan's calls, by index from 0. */
let script: (index: number) => ModelCall["outcome"] = () => "answered"

/** Fails a call as the case's script says, or answers its first two slugs as one group. */
function answer(request: http.IncomingMessage, response: http.ServerResponse) {
  let body = ""
  request.on("data", (chunk) => {
    body += chunk
  })
  request.on("end", () => {
    let prompt: string
    try {
      prompt = JSON.parse(body).messages.map((m: { content: unknown }) => JSON.stringify(m.content)).join("\n")
    } catch {
      // Not a model call: refused.
      console.error(`[llmw118] refused ${request.method} ${request.url}, not a model call`)
      response.writeHead(400).end()
      return
    }
    const slugs = [...prompt.matchAll(/slug=([^,]+),/g)].map((m) => m[1])
    const call = { pages: slugs.length, unpaired: slugs.filter((slug) => !pairedSlugs().has(slug)).length }
    const outcome = script(calls.length - scanStart)
    if (outcome === "http-429") {
      calls.push({ ...call, outcome })
      response.writeHead(429, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limit reached" } }))
      return
    }
    if (outcome === "connection-dropped") {
      calls.push({ ...call, outcome })
      request.socket.destroy()
      return
    }
    calls.push({ ...call, outcome: "answered" })
    const text = JSON.stringify({ groups: [{ slugs: slugs.slice(0, 2), reason: "live #118", confidence: "medium" }] })
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    for (const event of [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
}

/** The slugs of the pages the prefilter paired; entity and concept slugs are file names. */
function pairedSlugs(): Set<string> {
  return new Set([...paired.pages].map((page) => path.basename(page, ".md")))
}

/** A group saved for the Maintenance screen before the scheduled run (#118). */
const SAVED_GROUP = {
  slugs: ["llmw118-saved-a", "llmw118-saved-b"],
  reason: "saved before the run",
  confidence: "medium" as const,
}

function llmConfig(): LlmConfig {
  return {
    provider: "custom",
    apiKey: "none",
    model: "llmw118-scripted",
    ollamaUrl: "",
    customEndpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiMode: "anthropic_messages",
    maxContextSize: 200_000,
  }
}

/** One scan, then one scheduled run, of a fresh copy of the vault's first DEDUP_PAGES pages. */
async function scanAndRunOnVaultCopy(name: string) {
  const vault = process.env.DEDUP_VAULT_COPY ?? ""
  const pageCount = Number(process.env.DEDUP_PAGES ?? 600)
  const { loadAllEntitySummaries, runDuplicateDetection } = await import("./dedup-runner")
  const { runMaintenanceTick } = await import("./scheduled-maintenance")
  const { saveEmbeddingConfig, saveScheduledMaintenanceConfig } = await import("@/lib/project-store")
  const { loadPendingDuplicateGroups, savePendingDuplicateGroups } = await import("./dedup-storage")

  const chosen = (await loadAllEntitySummaries(vault)).slice(0, pageCount)
  const project = await createTempProject(name)
  try {
    await fs.mkdir(path.join(project.path, ".llm-wiki"), { recursive: true })
    for (const { path: rel } of chosen) {
      await fs.mkdir(path.dirname(path.join(project.path, rel)), { recursive: true })
      await fs.copyFile(path.join(vault, rel), path.join(project.path, rel))
    }
    const embedding: EmbeddingConfig = {
      enabled: true,
      endpoint: process.env.EMBEDDING_ENDPOINT ?? "",
      apiKey: "",
      model: process.env.EMBEDDING_MODEL ?? "",
    }
    await saveEmbeddingConfig(embedding)
    await saveScheduledMaintenanceConfig(project.path, { enabled: true, intervalHours: 24, lastRun: null })
    const projectRef = { id: `${name}-copy`, name: "copy", path: project.path }
    // The backfill is not this ticket's: off in the open project's settings.
    useWikiStore.setState({
      project: projectRef,
      llmConfig: llmConfig(),
      embeddingConfig: { ...embedding, enabled: false },
    })
    const warn = vi.spyOn(console, "warn")
    let warnings: string[] = []

    calls.length = 0
    scanStart = 0
    let scan: Awaited<ReturnType<typeof runDuplicateDetection>>
    let scanCalls: ModelCall[]
    let scanMs: number
    try {
      const started = Date.now()
      scan = await runDuplicateDetection(project.path, llmConfig())
      scanMs = Date.now() - started
      scanCalls = [...calls]
      scanStart = calls.length
      await savePendingDuplicateGroups(project.path, [SAVED_GROUP])
      await runMaintenanceTick(projectRef, { now: () => Date.now() })
    } finally {
      warnings = warn.mock.calls.map((args) => String(args[0]))
      warn.mockRestore()
    }
    const tickCalls = calls.slice(scanStart)
    const lines = (await fs.readFile(path.join(project.path, ".llm-wiki/maintenance-runs.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
    const record = JSON.parse(lines[lines.length - 1])
    const pending = await loadPendingDuplicateGroups(project.path)

    const report = {
      pages: chosen.length,
      pairedPages: paired.pages.size,
      scanCalls,
      scanMs,
      tickCalls,
      scanGroups: scan.groups.length,
      scanFailedBatches: scan.failedBatches,
      notDone: scan.notDone,
      prefilterFailedLogged: warnings.some((line) => /embedding prefilter failed/.test(line)),
      detectorCallFailedLogged: warnings.filter((line) => /detector call failed/.test(line)).length,
      stopLogged: warnings.filter((line) => /stopped after 2 detector calls in a row failed/.test(line)).length,
      record,
      pendingAfterRun: pending.length,
      savedGroupKept: pending.some((g) => g.reason === SAVED_GROUP.reason),
    }
    return { pageCount, chosen, scan, scanCalls, tickCalls, record, pending, report }
  } finally {
    await project.cleanup()
  }
}

describe.skipIf(!ENABLED)("a detector call that fails mid-scan, on a copy of a real vault (#118, #124)", () => {
  beforeAll(async () => {
    server = http.createServer(answer)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("reports the failed calls as failed batches, keeps the rest, and never restarts unprefiltered", async () => {
    // Apart, so the scan does not stop on them (#124).
    script = (index) => index === 1 ? "http-429" : index === 3 ? "connection-dropped" : "answered"
    const { pageCount, chosen, scan, scanCalls, tickCalls, record, pending, report } =
      await scanAndRunOnVaultCopy("llmw118-model-error")
    if (process.env.DEDUP_REPORT) {
      await fs.writeFile(`${process.env.DEDUP_REPORT}.model-error.json`, JSON.stringify(report, null, 2))
    }

    expect(chosen.length).toBe(pageCount)
    expect(scanCalls.length).toBeGreaterThanOrEqual(4)
    // The prefiltered batches only: a full scan would send the pages no pair holds.
    expect(report.pairedPages).toBeGreaterThan(0)
    expect(report.pairedPages).toBeLessThan(chosen.length)
    expect(scanCalls.every((c) => c.unpaired === 0)).toBe(true)
    expect(tickCalls.every((c) => c.unpaired === 0)).toBe(true)
    expect(scan.failedBatches).toEqual([
      { pages: scanCalls[1].pages, reason: expect.stringMatching(/^Duplicate detector call failed: .*429/) },
      { pages: scanCalls[3].pages, reason: expect.stringMatching(/^Duplicate detector call failed: /) },
    ])
    const answered = scanCalls.filter((c) => c.outcome === "answered").length
    expect(scan.groups.filter((g) => g.reason === "live #118")).toHaveLength(answered)
    expect(scan.notDone).toBeUndefined()
    expect(report.prefilterFailedLogged).toBe(false)
    // Two in the scan, two in the scheduled run's own scan.
    expect(report.detectorCallFailedLogged).toBe(4)
    expect(report.stopLogged).toBe(0)

    expect(tickCalls.map((c) => c.outcome)).toEqual(scanCalls.map((c) => c.outcome))
    expect(record.failedDetectorBatches).toEqual(scan.failedBatches.map((b) => ({
      pages: b.pages,
      reason: expect.stringMatching(/^Duplicate detector call failed: /),
    })))
    expect(record.error).toBeUndefined()
    expect(record.groupsFound.high).toBe(0)
    // The run's batches did not all answer, so the group saved before it stays.
    expect(pending).toContainEqual(SAVED_GROUP)
    expect(pending).toHaveLength(1 + record.groupsFound.medium + record.groupsFound.low)
  }, 60 * 60 * 1000)

  it("stops calling after two calls in a row fail, recording the batches left as not checked (#124)", async () => {
    script = (index) => index === 0 ? "answered" : "http-429"
    const { pageCount, chosen, scan, scanCalls, tickCalls, record, pending, report } =
      await scanAndRunOnVaultCopy("llmw124-stop")
    if (process.env.DEDUP_REPORT) {
      await fs.writeFile(`${process.env.DEDUP_REPORT}.stop.json`, JSON.stringify(report, null, 2))
    }

    expect(chosen.length).toBe(pageCount)
    expect(scanCalls.map((c) => c.outcome)).toEqual(["answered", "http-429", "http-429"])
    expect(scanCalls.every((c) => c.unpaired === 0)).toBe(true)
    const notChecked = scan.failedBatches.slice(2)
    expect(scan.failedBatches.slice(0, 2)).toEqual([
      { pages: scanCalls[1].pages, reason: expect.stringMatching(/^Duplicate detector call failed: .*429/) },
      { pages: scanCalls[2].pages, reason: expect.stringMatching(/^Duplicate detector call failed: .*429/) },
    ])
    // The case is only a test of the stop if batches were left.
    expect(notChecked.length).toBeGreaterThan(0)
    for (const batch of notChecked) {
      expect(batch.pages).toBeGreaterThan(0)
      expect(batch.reason).toBe("Not checked: the scan stopped after 2 detector calls in a row failed")
    }
    expect(scan.groups.filter((g) => g.reason === "live #118")).toHaveLength(1)
    expect(scan.notDone).toBeUndefined()
    expect(report.prefilterFailedLogged).toBe(false)
    // Once in the scan, once in the scheduled run's own scan.
    expect(report.stopLogged).toBe(2)

    expect(tickCalls.map((c) => c.outcome)).toEqual(["answered", "http-429", "http-429"])
    expect(record.failedDetectorBatches).toEqual(scan.failedBatches)
    expect(record.error).toBeUndefined()
    // The run's batches did not all answer, so the group saved before it stays.
    expect(pending).toContainEqual(SAVED_GROUP)
    expect(pending).toHaveLength(1 + record.groupsFound.medium + record.groupsFound.low)
  }, 60 * 60 * 1000)
})
