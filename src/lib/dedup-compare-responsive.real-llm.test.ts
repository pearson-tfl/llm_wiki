/**
 * The duplicate scan's pairwise compare keeps the app responsive and can be
 * cancelled (#122), end to end on a copy of a real vault: the real
 * runDuplicateDetection and startDuplicateScan with the real embedding
 * endpoint. The Tauri layer is replaced: files through node:fs, embeddings
 * by a direct call to the endpoint, the settings store by an in-memory one.
 * The model is a stub that finds no groups: the compare, not the detector,
 * is under test.
 *
 * - A timer set to tick every 5 ms while the scan runs: the longest gap
 *   between its ticks from the last embedding to the compare's end.
 * - The pairs the compare finds, against the compare before #122 on the
 *   same real vectors.
 * - A Cancel half a second into the compare: how long the scan takes to end.
 *
 * Gated behind RUN_LLM_TESTS=1, EMBEDDING_ENDPOINT, EMBEDDING_MODEL and
 * DEDUP_VAULT_COPY, the path of the copy. Writes each case's measurements
 * beside DEDUP_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { realFs } from "@/test-helpers/fs-temp"
import { pairsBefore122 } from "@/test-helpers/dedup-pairs-before-122"
import type { EmbeddingConfig, LlmConfig } from "@/stores/wiki-store"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1"
  && !!process.env.EMBEDDING_ENDPOINT
  && !!process.env.EMBEDDING_MODEL
  && !!process.env.DEDUP_VAULT_COPY

const storage = vi.hoisted(() => new Map<string, unknown>())
/** Each embedding by its input text, so the second scan reuses the first's real vectors. */
const vectorsByText = vi.hoisted(() => new Map<string, number[]>())
const measured = vi.hoisted(() => ({
  embedded: 0,
  lastEmbeddedAt: 0,
  modelCalls: 0,
  prefilter: undefined as
    | { pages: import("@/lib/dedup_embedding").Page[]; pairs?: Array<readonly [string, string]>; endedAt: number }
    | undefined,
}))

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
      const record: NonNullable<typeof measured.prefilter> = { pages: args[0], endedAt: 0 }
      measured.prefilter = record
      try {
        record.pairs = await actual.candidatePairs(...args)
        return record.pairs
      } finally {
        record.endedAt = performance.now()
      }
    },
  }
})

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>()
  return {
    ...actual,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "embedding_fetch") {
        const text = String(args?.text)
        let vector = vectorsByText.get(text)
        if (!vector) {
          const cfg = args?.cfg as { endpoint: string; model: string }
          const response = await fetch(cfg.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: cfg.model, input: text }),
          })
          if (!response.ok) throw new Error(`embedding endpoint answered ${response.status}`)
          vector = (await response.json()).data[0].embedding as number[]
          vectorsByText.set(text, vector)
        }
        measured.embedded++
        measured.lastEmbeddedAt = performance.now()
        return vector
      }
      throw new Error(`unexpected invoke ${cmd}`)
    },
  }
})

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: async (
      _config: unknown,
      _messages: unknown,
      callbacks: { onToken: (t: string) => void; onDone: () => void },
    ) => {
      measured.modelCalls++
      callbacks.onToken('{"groups": []}')
      callbacks.onDone()
    },
  }
})

const LLM_CONFIG: LlmConfig = {
  provider: "claude-code",
  apiKey: "",
  model: "claude-opus-5-5",
  ollamaUrl: "",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxContextSize: 200_000,
}

/** The prefilter's settings in dedup-runner.ts, which the reference compare is given. */
const DEDUP_PREFILTER_TOP_K = 8
const DEDUP_PREFILTER_THRESHOLD = 0.68
/** The longest the app may go without running a timer during the compare. */
const LONGEST_GAP_MS = 200
/** The longest a Cancel may take to end a scan in its compare. */
const CANCEL_WITHIN_MS = 200

async function useRealEmbeddings() {
  const { saveEmbeddingConfig } = await import("@/lib/project-store")
  const embedding: EmbeddingConfig = {
    enabled: true,
    endpoint: process.env.EMBEDDING_ENDPOINT ?? "",
    apiKey: "",
    model: process.env.EMBEDDING_MODEL ?? "",
  }
  await saveEmbeddingConfig(embedding)
  Object.assign(measured, { embedded: 0, lastEmbeddedAt: 0, modelCalls: 0, prefilter: undefined })
}

/** Records when a 5 ms timer runs, until stopped. */
function timerTicks() {
  const ticks: number[] = []
  const timer = setInterval(() => ticks.push(performance.now()), 5)
  return {
    ticks,
    stop: () => clearInterval(timer),
  }
}

/** Each case's measurements, to `<DEDUP_REPORT>.<case>.json` when DEDUP_REPORT is set. */
async function writeReport(name: string, report: unknown) {
  if (process.env.DEDUP_REPORT) await fs.writeFile(`${process.env.DEDUP_REPORT}.${name}.json`, JSON.stringify(report, null, 2))
}

describe.skipIf(!ENABLED)("the duplicate scan's compare on a real vault copy (#122)", () => {
  it("runs a timer every few milliseconds through the compare, and finds the pairs it found before #122", async () => {
    const { runDuplicateDetection } = await import("./dedup-runner")
    const { pageToEmbeddingText } = await import("@/lib/dedup_embedding")
    await useRealEmbeddings()

    const timer = timerTicks()
    const startedAt = performance.now()
    let result
    try {
      result = await runDuplicateDetection(process.env.DEDUP_VAULT_COPY ?? "", LLM_CONFIG)
    } finally {
      timer.stop()
    }
    const prefilter = measured.prefilter!
    // The gaps from the last embedding to the compare's end, both ends counted.
    const inCompare = [
      measured.lastEmbeddedAt,
      ...timer.ticks.filter((t) => t > measured.lastEmbeddedAt && t < prefilter.endedAt),
      prefilter.endedAt,
    ]
    const longestGap = Math.max(...inCompare.slice(1).map((t, i) => t - inCompare[i]))

    const vectors = new Map(prefilter.pages.map((p) => [p.id, vectorsByText.get(pageToEmbeddingText(p)) ?? null]))
    const before = pairsBefore122(prefilter.pages, vectors, DEDUP_PREFILTER_TOP_K, DEDUP_PREFILTER_THRESHOLD)

    const report = {
      pages: prefilter.pages.length,
      embedded: measured.embedded,
      dimensions: vectors.values().next().value?.length,
      compareMs: Math.round(prefilter.endedAt - measured.lastEmbeddedAt),
      ticksInCompare: inCompare.length - 2,
      longestGapMs: Math.round(longestGap),
      scanMs: Math.round(performance.now() - startedAt),
      pairs: prefilter.pairs?.length,
      pairsBefore122: before.length,
      samePairsInOrder: JSON.stringify(prefilter.pairs) === JSON.stringify(before),
      modelCalls: measured.modelCalls,
      notDone: result.notDone,
    }
    await writeReport("responsive", report)

    expect(report.pages).toBeGreaterThan(4000)
    expect(report.embedded).toBe(report.pages)
    expect(report.pairs).toBeGreaterThan(0)
    expect(prefilter.pairs).toEqual(before)
    expect(report.longestGapMs).toBeLessThan(LONGEST_GAP_MS)
  }, 60 * 60 * 1000)

  it("ends a scan cancelled half a second into the compare, with no result, no error and no model call", async () => {
    const { startDuplicateScan } = await import("./dedup-runner")
    await useRealEmbeddings()

    const scan = startDuplicateScan(process.env.DEDUP_VAULT_COPY ?? "", LLM_CONFIG)
    await vi.waitFor(() => expect(measured.prefilter).toBeDefined(), { timeout: 60_000, interval: 10 })
    const pages = measured.prefilter!.pages.length
    await vi.waitFor(() => expect(measured.embedded).toBe(pages), { timeout: 30 * 60 * 1000, interval: 10 })
    const compareStartedAt = measured.lastEmbeddedAt

    await new Promise((resolve) => setTimeout(resolve, 500))
    const cancelledAt = performance.now()
    scan.cancel()
    const outcome = await scan.done
    const endedAt = performance.now()

    const report = {
      pages,
      cancelledIntoCompareMs: Math.round(cancelledAt - compareStartedAt),
      endedAfterCancelMs: Math.round(endedAt - cancelledAt),
      outcome,
      prefilterFinished: measured.prefilter!.pairs !== undefined,
      modelCalls: measured.modelCalls,
    }
    await writeReport("cancel", report)

    expect(report.outcome).toBeNull()
    expect(report.prefilterFinished).toBe(false)
    expect(report.endedAfterCancelMs).toBeLessThan(CANCEL_WITHIN_MS)
    expect(report.modelCalls).toBe(0)
  }, 60 * 60 * 1000)
})
