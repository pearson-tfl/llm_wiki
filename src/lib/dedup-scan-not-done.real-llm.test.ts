/**
 * A duplicate scan the model does not do (#112), end to end on a copy of a
 * real vault: the real runDuplicateDetection and the real scheduled
 * runMaintenanceTick, with the real embedding endpoint. The Tauri layer is
 * replaced: files through node:fs, embeddings by a direct call to the
 * endpoint, the settings store by an in-memory one. Any detector call
 * fails the test: neither case may reach the detector. The shared-slug
 * judge's calls (#135) are refused here, so its groups stay as found.
 *
 * - Coverage too low: the copy, scanned with an embedding model the
 *   endpoint does not hold, so it embeds no page.
 * - No candidate pairs: 260 of the copy's pages, chosen with the real
 *   embeddings so no two of them reach the prefilter's threshold, copied to
 *   a fresh project.
 * - The embedding server down (#117): the copy's scheduled run, with an
 *   endpoint that never resolves, keeps the pending groups an earlier run
 *   saved in the copy.
 * - A saved group's page gone (#120): the same run, after a page of one of
 *   those groups is deleted from the copy, drops that group and keeps the
 *   others.
 *
 * Gated behind RUN_LLM_TESTS=1, EMBEDDING_ENDPOINT, EMBEDDING_MODEL and
 * DEDUP_VAULT_COPY, the path of the copy, which the scheduled run writes its
 * record and pending groups into; the #117 case needs only RUN_LLM_TESTS=1
 * and DEDUP_VAULT_COPY. Never point it at a live vault. Writes each case's
 * measurements beside DEDUP_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"
import { useWikiStore, type EmbeddingConfig, type LlmConfig } from "@/stores/wiki-store"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1"
  && !!process.env.EMBEDDING_ENDPOINT
  && !!process.env.EMBEDDING_MODEL
  && !!process.env.DEDUP_VAULT_COPY

const storage = vi.hoisted(() => new Map<string, unknown>())
const measured = vi.hoisted(() => ({ pairs: -1, modelCalls: 0 }))

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
      measured.pairs = pairs.length
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
      // The detector's calls are counted; the judge's (#135) are only refused.
      const messages = (args?.messages ?? []) as { content: string }[]
      if (cmd === "claude_cli_spawn" && !messages[0]?.content.includes("share a file name")) measured.modelCalls++
      throw new Error(`unexpected invoke ${cmd}`)
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

/** The prefilter's threshold, as in dedup-runner.ts; a wiki over 250 pages is not scanned without a pair. */
const PREFILTER_THRESHOLD = 0.68
const DISTINCT_PAGES = 260

function embeddingConfig(model: string): EmbeddingConfig {
  return {
    enabled: true,
    endpoint: process.env.EMBEDDING_ENDPOINT ?? "",
    apiKey: "",
    model,
  }
}

/** One scan and one scheduled run of `projectPath`, the run's record read back from disk. */
async function scanAndRun(projectPath: string, embedding: EmbeddingConfig) {
  const { saveEmbeddingConfig, saveScheduledMaintenanceConfig } = await import("@/lib/project-store")
  const { runDuplicateDetection } = await import("./dedup-runner")
  const { runMaintenanceTick } = await import("./scheduled-maintenance")
  await saveEmbeddingConfig(embedding)
  await saveScheduledMaintenanceConfig(projectPath, { enabled: true, intervalHours: 24, lastRun: null })
  // The backfill is not this ticket's: off in the open project's settings.
  useWikiStore.setState({
    project: { id: "llmw-112-copy", name: "copy", path: projectPath },
    llmConfig: LLM_CONFIG,
    embeddingConfig: { ...embedding, enabled: false },
  })

  measured.pairs = -1
  const scan = await runDuplicateDetection(projectPath, LLM_CONFIG)
  const scanPairs = measured.pairs
  const returned = await runMaintenanceTick(
    { id: "llmw-112-copy", name: "copy", path: projectPath },
    { now: () => Date.now() },
  )
  const lines = (await fs.readFile(path.join(projectPath, ".llm-wiki/maintenance-runs.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
  const record = JSON.parse(lines[lines.length - 1])
  return { scan, scanPairs, returned, record }
}

/** Each case's measurements, to `<DEDUP_REPORT>.<case>.json` when DEDUP_REPORT is set. */
async function writeReport(name: string, report: unknown) {
  if (process.env.DEDUP_REPORT) await fs.writeFile(`${process.env.DEDUP_REPORT}.${name}.json`, JSON.stringify(report, null, 2))
}

describe.skipIf(!ENABLED)("a duplicate scan the model does not do, on a copy of a real vault (#112)", () => {
  it("reports a wiki whose pages cannot be embedded as not done, in the scan and the run record", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    measured.modelCalls = 0

    const { scan, scanPairs, record } = await scanAndRun(vault, embeddingConfig("llmw112-embedder-not-pulled"))

    const { loadAllEntitySummaries } = await import("./dedup-runner")
    const pages = (await loadAllEntitySummaries(vault)).length
    const report = {
      pages,
      scanPairs,
      notDone: scan.notDone,
      groups: scan.groups.length,
      groupConfidences: [...new Set(scan.groups.map((g) => g.confidence))],
      failedBatches: scan.failedBatches.length,
      modelCalls: measured.modelCalls,
      record,
    }
    await writeReport("coverage", report)

    expect(pages).toBeGreaterThan(250)
    expect(scan.notDone).toEqual({ reason: "embedding-coverage-low", pages })
    expect(record.duplicateScanNotDone).toEqual({ reason: "embedding-coverage-low", pages })
    expect(record.error).toBeUndefined()
    // Only the same-slug groups (#109), found from file names; their
    // judge's calls are refused here (#135), so they stay medium.
    expect(report.groupConfidences).toEqual(["medium"])
    expect(measured.modelCalls).toBe(0)
  }, 30 * 60 * 1000)

  it("reports a wiki whose prefilter finds no pairs as not done, in the scan and the run record", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    const embedding = embeddingConfig(process.env.EMBEDDING_MODEL ?? "")
    measured.modelCalls = 0
    const { loadAllEntitySummaries, summaryToEmbeddingPage } = await import("./dedup-runner")
    const { embedPages, cosineSimilarity } = await import("@/lib/dedup_embedding")

    // Pick, in file order, each page below the threshold to every page picked
    // before it, one page per slug so no same-slug group (#109) forms.
    const summaries = await loadAllEntitySummaries(vault)
    const vectors = await embedPages(summaries.map(summaryToEmbeddingPage), embedding)
    const picked: { path: string; slug: string; vector: number[] }[] = []
    for (const summary of summaries) {
      const vector = vectors.get(summary.path)
      if (!vector || picked.some((p) => p.slug === summary.slug)) continue
      if (picked.every((p) => cosineSimilarity(p.vector, vector) < PREFILTER_THRESHOLD)) {
        picked.push({ path: summary.path, slug: summary.slug, vector })
        if (picked.length === DISTINCT_PAGES) break
      }
    }
    expect(picked.length).toBe(DISTINCT_PAGES)

    const project = await createTempProject("llmw112-distinct")
    try {
      await fs.mkdir(path.join(project.path, ".llm-wiki"), { recursive: true })
      for (const { path: rel } of picked) {
        await fs.mkdir(path.dirname(path.join(project.path, rel)), { recursive: true })
        await fs.copyFile(path.join(vault, rel), path.join(project.path, rel))
      }

      const { scan, scanPairs, record } = await scanAndRun(project.path, embedding)

      const report = {
        pages: picked.length,
        scanPairs,
        notDone: scan.notDone,
        groups: scan.groups.length,
        failedBatches: scan.failedBatches.length,
        modelCalls: measured.modelCalls,
        record,
      }
      await writeReport("no-pairs", report)

      expect(scanPairs).toBe(0)
      expect(scan).toStrictEqual({
        groups: [],
        failedBatches: [],
        notDone: { reason: "no-candidate-pairs", pages: DISTINCT_PAGES },
      })
      expect(record.duplicateScanNotDone).toEqual({ reason: "no-candidate-pairs", pages: DISTINCT_PAGES })
      expect(record.groupsFound).toEqual({ high: 0, medium: 0, low: 0 })
      expect(record.error).toBeUndefined()
      expect(measured.modelCalls).toBe(0)
    } finally {
      await project.cleanup()
    }
  }, 30 * 60 * 1000)
})

describe.skipIf(!(process.env.RUN_LLM_TESTS === "1" && process.env.DEDUP_VAULT_COPY))(
  "a scheduled run whose duplicate scan is not done, on a copy of a real vault (#117)",
  () => {
    it("keeps the groups an earlier run saved, with the embedding server down, and adds its same-slug groups", async () => {
      const vault = process.env.DEDUP_VAULT_COPY ?? ""
      measured.modelCalls = 0
      const pendingPath = path.join(vault, ".llm-wiki/dedup-pending-groups.json")
      const earlier = JSON.parse(await fs.readFile(pendingPath, "utf8"))

      // A host that never resolves: every embed fails, as with the server down overnight.
      const { scan, record } = await scanAndRun(vault, {
        ...embeddingConfig("qwen3-embedding:0.6b"),
        endpoint: "http://embedding-server-down.invalid/v1/embeddings",
      })
      const saved = JSON.parse(await fs.readFile(pendingPath, "utf8"))

      await writeReport("keeps-pending", { earlier, scanGroups: scan.groups, saved, modelCalls: measured.modelCalls, record })

      expect(earlier.length).toBeGreaterThan(0)
      expect(record.duplicateScanNotDone?.reason).toBe("embedding-coverage-low")
      expect(scan.groups.length).toBeGreaterThan(0)
      expect(saved).toEqual(expect.arrayContaining(earlier))
      expect(saved).toEqual(expect.arrayContaining(scan.groups))
      expect(saved).toHaveLength(earlier.length + scan.groups.length)
      expect(measured.modelCalls).toBe(0)
    }, 30 * 60 * 1000)
  },
)

describe.skipIf(!(process.env.RUN_LLM_TESTS === "1" && process.env.DEDUP_VAULT_COPY))(
  "a scheduled run that adds to the saved groups, on a copy of a real vault (#120)",
  () => {
    it("drops a saved group whose page is no longer on disk and keeps the rest, with the embedding server down", async () => {
      const vault = process.env.DEDUP_VAULT_COPY ?? ""
      measured.modelCalls = 0
      const pendingPath = path.join(vault, ".llm-wiki/dedup-pending-groups.json")
      const earlier: { slugs: string[] }[] = JSON.parse(await fs.readFile(pendingPath, "utf8"))
      // As if the first earlier group's first page had since been merged away.
      const { pagesNamed } = await import("./dedup")
      const { listWikiPages } = await import("./dedup-storage")
      const [gone] = pagesNamed(await listWikiPages(vault), earlier[0].slugs[0])
      await fs.rm(gone.file)

      const { scan, record } = await scanAndRun(vault, {
        ...embeddingConfig("qwen3-embedding:0.6b"),
        endpoint: "http://embedding-server-down.invalid/v1/embeddings",
      })
      const saved = JSON.parse(await fs.readFile(pendingPath, "utf8"))

      await writeReport("prunes-pending", { earlier, deleted: gone.path, scanGroups: scan.groups, saved, modelCalls: measured.modelCalls, record })

      expect(earlier.length).toBeGreaterThan(1)
      expect(record.duplicateScanNotDone?.reason).toBe("embedding-coverage-low")
      expect(saved).not.toContainEqual(earlier[0])
      expect(saved).toEqual(expect.arrayContaining(earlier.slice(1)))
      expect(saved).toEqual(expect.arrayContaining(scan.groups))
      // A group found again stands once, as its fresh copy.
      const pages = (g: { slugs: string[] }) => [...g.slugs].sort().join()
      expect(saved).toHaveLength(new Set([...earlier.slice(1), ...scan.groups].map(pages)).size)
      expect(measured.modelCalls).toBe(0)
    }, 30 * 60 * 1000)
  },
)
