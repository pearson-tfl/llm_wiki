/**
 * The duplicate scan's embedding prefilter covers every page (#116), end to
 * end on a copy of a real vault: the real runDuplicateDetection with the
 * real embedding endpoint. The Tauri layer is replaced: files through
 * node:fs, embeddings by a direct call to the endpoint, the settings store
 * by an in-memory one. The model is a stub that finds no groups: the
 * prefilter, not the detector, is under test.
 *
 * - The vault copy as it is: the scan reads its entity and concept pages.
 * - Every page of the copy placed under wiki/entities/ in a fresh project,
 *   so the scan reads more than 5,000 pages, past the old cap.
 *
 * Gated behind RUN_LLM_TESTS=1, EMBEDDING_ENDPOINT, EMBEDDING_MODEL and
 * DEDUP_VAULT_COPY, the path of the copy. Writes each case's measurements
 * beside DEDUP_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"
import type { EmbeddingConfig, LlmConfig } from "@/stores/wiki-store"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1"
  && !!process.env.EMBEDDING_ENDPOINT
  && !!process.env.EMBEDDING_MODEL
  && !!process.env.DEDUP_VAULT_COPY

const storage = vi.hoisted(() => new Map<string, unknown>())
const measured = vi.hoisted(() => ({ sentToPrefilter: -1, embedded: 0, pairs: -1, modelCalls: 0 }))

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
      measured.sentToPrefilter = args[0].length
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
        measured.embedded++
        return (await response.json()).data[0].embedding
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
      messages: { content: string }[],
      callbacks: { onToken: (t: string) => void; onDone: () => void; onError: (err: Error) => void },
    ) => {
      // The shared-slug judge (#135) is refused, so it records no verdict in the copy.
      if (messages[0]?.content.includes("share a file name")) {
        callbacks.onError(new Error("the judge is not this test's"))
        return
      }
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

/** One scan of `projectPath`, with the pages it read and the prefilter's measurements. */
async function scan(projectPath: string) {
  const { saveEmbeddingConfig } = await import("@/lib/project-store")
  const { runDuplicateDetection, loadAllEntitySummaries } = await import("./dedup-runner")
  const embedding: EmbeddingConfig = {
    enabled: true,
    endpoint: process.env.EMBEDDING_ENDPOINT ?? "",
    apiKey: "",
    model: process.env.EMBEDDING_MODEL ?? "",
  }
  await saveEmbeddingConfig(embedding)

  Object.assign(measured, { sentToPrefilter: -1, embedded: 0, pairs: -1, modelCalls: 0 })
  const result = await runDuplicateDetection(projectPath, LLM_CONFIG)
  const pagesRead = (await loadAllEntitySummaries(projectPath)).length
  return {
    pagesRead,
    sentToPrefilter: measured.sentToPrefilter,
    embedded: measured.embedded,
    pairs: measured.pairs,
    modelCalls: measured.modelCalls,
    groups: result.groups.length,
    failedBatches: result.failedBatches.length,
    notDone: result.notDone,
  }
}

/** Each case's measurements, to `<DEDUP_REPORT>.<case>.json` when DEDUP_REPORT is set. */
async function writeReport(name: string, report: unknown) {
  if (process.env.DEDUP_REPORT) await fs.writeFile(`${process.env.DEDUP_REPORT}.${name}.json`, JSON.stringify(report, null, 2))
}

/** Every .md file under `dir`, as paths relative to it. */
async function markdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
}

describe.skipIf(!ENABLED)("the embedding prefilter covers every page of a real vault copy (#116)", () => {
  it("embeds every page the scan reads from the vault copy", async () => {
    const report = await scan(process.env.DEDUP_VAULT_COPY ?? "")
    await writeReport("vault", report)

    expect(report.pagesRead).toBeGreaterThan(250)
    expect(report.sentToPrefilter).toBe(report.pagesRead)
    expect(report.embedded).toBe(report.pagesRead)
    expect(report.notDone).toBeUndefined()
  }, 30 * 60 * 1000)

  it("embeds every page of a wiki of more than 5,000 pages, past the old cap", async () => {
    const wiki = path.join(process.env.DEDUP_VAULT_COPY ?? "", "wiki")
    const project = await createTempProject("llmw116-over-cap")
    try {
      for (const rel of await markdownFiles(wiki)) {
        const target = path.join(project.path, "wiki/entities", rel)
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.copyFile(path.join(wiki, rel), target)
      }

      const report = await scan(project.path)
      await writeReport("over-cap", report)

      expect(report.pagesRead).toBeGreaterThan(5000)
      expect(report.sentToPrefilter).toBe(report.pagesRead)
      expect(report.embedded).toBe(report.pagesRead)
      expect(report.notDone).toBeUndefined()
    } finally {
      await project.cleanup()
    }
  }, 60 * 60 * 1000)
})
