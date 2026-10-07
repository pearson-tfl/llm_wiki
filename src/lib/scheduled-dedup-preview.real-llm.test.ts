/**
 * What the scheduled maintenance run would merge (#111): the real
 * runDuplicateDetection on a copy of a real vault, on the model the
 * scheduled run resolves – getTaskLlmConfig("ingest") over the store
 * loaded from app-state field by field – with the real embedding endpoint.
 * The Tauri layer is replaced: files through node:fs, embeddings by a
 * direct call to the endpoint. HTTP model calls go out through node's
 * fetch, as tauri-fetch does outside the webview. Where a host is slow to
 * connect, node's fetch gives each address 250 ms and fails; run it with
 * NODE_OPTIONS="--dns-result-order=ipv4first
 * --network-family-autoselection-attempt-timeout=5000" (api.z.ai from the
 * Mac, #111).
 *
 * Gated behind RUN_LLM_TESTS=1, APP_STATE (the app-state.json to read; it
 * is only read, and its key never leaves this process) and
 * PREVIEW_VAULT_COPY, a copy under the OS temp folder. Writes its report,
 * every high-confidence group with each page's title and first line, to
 * PREVIEW_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import { appFs } from "@/test-helpers/fs-temp"
import { minutesSince, pagesFor, seedStoreFromAppState, tempVaultCopy, type SavedAppState } from "@/test-helpers/scheduled-preview"
import type { EmbeddingConfig } from "@/stores/wiki-store"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1"
  && !!process.env.APP_STATE
  && !!process.env.PREVIEW_VAULT_COPY

const measured = {
  pairs: 0,
  clusterSizes: [] as number[],
  calls: [] as { pages: number; seconds: number; error?: string }[],
}

let embeddingConfig: EmbeddingConfig | null = null

vi.mock("@/commands/fs", () => appFs)

vi.mock("@/lib/project-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-store")>()),
  loadEmbeddingConfig: async () => embeddingConfig,
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
    clusterByPairs: (...args: Parameters<typeof actual.clusterByPairs>) => {
      const clusters = actual.clusterByPairs(...args)
      measured.clusterSizes = clusters.map((c) => c.length).sort((a, b) => b - a)
      return clusters
    },
  }
})

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  return {
    ...actual,
    streamChat: async (...args: Parameters<typeof actual.streamChat>) => {
      const [config, messages, callbacks, signal, overrides] = args
      const user = messages.find((m) => m.role === "user")?.content
      const pages = Number(String(user).match(/Wiki pages to scan \((\d+) entries\)/)?.[1])
      const started = Date.now()
      const call: (typeof measured.calls)[number] = { pages, seconds: 0 }
      measured.calls.push(call)
      const onError = callbacks.onError
      try {
        return await actual.streamChat(config, messages, {
          ...callbacks,
          onError: (err) => {
            call.error = err.message
            onError(err)
          },
        }, signal, overrides)
      } finally {
        call.seconds = Math.round((Date.now() - started) / 1000)
        process.stderr.write(`detector call ${measured.calls.length}: ${JSON.stringify(call)}\n`)
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

describe.skipIf(!ENABLED)("the scheduled duplicate scan on a copy of a real vault", () => {
  it("runs on the scheduled run's own route and lists what it would merge", async () => {
    const vault = await tempVaultCopy(process.env.PREVIEW_VAULT_COPY ?? "")

    // The fields the app loads at start-up, as they are in app-state.
    const state: SavedAppState = JSON.parse(await fs.readFile(process.env.APP_STATE ?? "", "utf8"))
    embeddingConfig = state.embeddingConfig
    seedStoreFromAppState(state, { id: "llmw-111-copy", name: "copy", path: vault })
    const { getTaskLlmConfig } = await import("./llm-task-routing")
    const { hasUsableLlm } = await import("./has-usable-llm")
    const { runDuplicateDetection, loadAllWikiPages } = await import("./dedup-runner")
    const llmConfig = getTaskLlmConfig("ingest")
    const route = {
      provider: llmConfig.provider,
      model: llmConfig.model,
      endpoint: llmConfig.customEndpoint,
      apiMode: llmConfig.apiMode,
      ingestReasoning: llmConfig.ingestReasoning,
      usable: hasUsableLlm(llmConfig),
    }
    console.log(JSON.stringify({ route }))
    expect(route.usable).toBe(true)

    const started = Date.now()
    const result = await runDuplicateDetection(vault, llmConfig)
    const minutes = minutesSince(started)

    const pages = await loadAllWikiPages(vault)
    const high = result.groups.filter((g) => g.confidence === "high")
    const highGroupsOf = new Map<string, number[]>()
    high.forEach((g, i) => {
      for (const slug of new Set(g.slugs)) highGroupsOf.set(slug, [...(highGroupsOf.get(slug) ?? []), i + 1])
    })
    const report = {
      route,
      minutes,
      candidatePairs: measured.pairs,
      clusters: measured.clusterSizes.length,
      largestClusters: measured.clusterSizes.slice(0, 5),
      detectorCalls: measured.calls.length,
      largestBatch: Math.max(0, ...measured.calls.map((c) => c.pages)),
      callErrors: measured.calls.filter((c) => c.error),
      slowestCallSeconds: Math.max(0, ...measured.calls.map((c) => c.seconds)),
      failedBatches: result.failedBatches,
      notDone: result.notDone ?? null,
      groups: {
        total: result.groups.length,
        high: high.length,
        medium: result.groups.filter((g) => g.confidence === "medium").length,
        low: result.groups.filter((g) => g.confidence === "low").length,
      },
      inSeveralHighGroups: [...highGroupsOf].filter(([, groups]) => groups.length > 1)
        .map(([slug, groups]) => ({ slug, groups })),
      repeatedSlugGroups: high.flatMap((g, i) => (new Set(g.slugs).size < g.slugs.length ? [i + 1] : [])),
      highGroups: high.map((g, i) => ({
        group: i + 1,
        slugs: g.slugs,
        reason: g.reason,
        pages: [...new Set(g.slugs)].flatMap((slug) => pagesFor(slug, pages)),
      })),
      otherGroups: result.groups.filter((g) => g.confidence !== "high"),
    }
    if (process.env.PREVIEW_REPORT) await fs.writeFile(process.env.PREVIEW_REPORT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...report, highGroups: undefined, otherGroups: undefined }))

    // The detector's batch cap, DEDUP_DETECTOR_BATCH_SUMMARIES in dedup-runner.ts.
    expect(report.largestBatch).toBeLessThanOrEqual(80)
  }, 6 * 60 * 60 * 1000)
})
