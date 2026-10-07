/**
 * The duplicate scan (#108) end to end on a copy of a real vault: the real
 * runDuplicateDetection, the real embedding endpoint, and the real Claude
 * Code CLI through `scripts/estate/live-cli.sh`, which runs it under the
 * lane fence with the app's arguments. The Tauri layer is replaced: files
 * through node:fs, embeddings by a direct call to the endpoint, and the
 * CLI's stdout lines handed to the transport as the app's events.
 *
 * Gated behind RUN_LLM_TESTS=1, EMBEDDING_ENDPOINT, EMBEDDING_MODEL and
 * DEDUP_VAULT_COPY, the path of the copy. Never point it at a live vault.
 * Writes its measurements to DEDUP_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { realFs } from "@/test-helpers/fs-temp"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1"
  && !!process.env.EMBEDDING_ENDPOINT
  && !!process.env.EMBEDDING_MODEL
  && !!process.env.DEDUP_VAULT_COPY

const LIVE_CLI = path.resolve(__dirname, "../../scripts/estate/live-cli.sh")

const measured = {
  pairs: 0,
  clusterSizes: [] as number[],
  batchSizes: [] as number[],
  /** Each call's pages as `type/slug`, read from the prompt the model got. */
  calls: [] as string[][],
}

vi.mock("@/commands/fs", () => realFs)

vi.mock("@/lib/project-store", () => ({
  loadEmbeddingConfig: async () => ({
    enabled: true,
    endpoint: process.env.EMBEDDING_ENDPOINT,
    apiKey: "",
    model: process.env.EMBEDDING_MODEL,
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
    clusterByPairs: (...args: Parameters<typeof actual.clusterByPairs>) => {
      const clusters = actual.clusterByPairs(...args)
      measured.clusterSizes = clusters.map((c) => c.length).sort((a, b) => b - a)
      return clusters
    },
  }
})

const listeners = new Map<string, (event: { payload: unknown }) => void>()

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (topic: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(topic, handler)
    return () => listeners.delete(topic)
  },
}))

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
      if (cmd === "claude_cli_spawn") {
        void runCli(args as { streamId: string; messages: { role: string; content: string }[] })
        return undefined
      }
      if (cmd === "claude_cli_kill") return undefined
      throw new Error(`unexpected invoke ${cmd}`)
    },
  }
})

/** As `build_claude_stdin` does for a system and a user message: one user
 *  turn, the system text first. The detector's prompt holds no turn tags. */
async function runCli(args: { streamId: string; messages: { role: string; content: string }[] }) {
  const system = args.messages.find((m) => m.role === "system")?.content ?? ""
  const user = args.messages.find((m) => m.role === "user")?.content ?? ""
  measured.batchSizes.push(Number(user.match(/Wiki pages to scan \((\d+) entries\)/)?.[1]))
  measured.calls.push([...user.matchAll(/type=([^,]+), slug=([^,]+),/g)].map((m) => `${m[1]}/${m[2]}`))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmw108-cli-"))
  const stdinFile = path.join(dir, "stdin.jsonl")
  const outFile = path.join(dir, "out.jsonl")
  const turn = { type: "user", message: { role: "user", content: [{ type: "text", text: `${system}\n\n${user}` }] } }
  await fs.writeFile(stdinFile, `${JSON.stringify(turn)}\n`)
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(LIVE_CLI, [stdinFile, outFile], { stdio: ["ignore", "ignore", "pipe"] })
    let err = ""
    child.stderr.on("data", (chunk) => { err += String(chunk) })
    child.on("close", (exitCode) => resolve({ code: exitCode, stderr: err }))
  })
  const lines = (await fs.readFile(outFile, "utf8").catch(() => "")).split("\n").filter(Boolean)
  for (const line of lines) listeners.get(`claude-cli:${args.streamId}`)?.({ payload: line })
  listeners.get(`claude-cli:${args.streamId}:done`)?.({ payload: { code, stderr } })
  await fs.rm(dir, { recursive: true, force: true })
}

/** The #69 twins (comment 6013017770), as `type/slug`. A concept and an
 *  entity sharing a slug are found when a group lists that slug twice. */
const TWINS: [string, string][] = [
  ["entity/claude-3-7-sonnet", "entity/claude-sonnet-3-7"],
  ["entity/openclaw-secretref", "entity/openclaw-secretrefs"],
  ["concept/agent-skills", "entity/agent-skills"],
  ["concept/openclaw-code-mode", "entity/openclaw-code-mode"],
  ["entity/openclaw-compaction-provider", "entity/openclaw-compaction-provider-api"],
]
const slugOf = (page: string) => page.split("/")[1]

describe.skipIf(!ENABLED)("the duplicate scan on a copy of a real vault", () => {
  it("bounds every detector call and finds the known twins", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    useWikiStore.setState({ project: { id: "llmw-108-copy", name: "copy", path: vault } })
    const llmConfig: LlmConfig = {
      provider: "claude-code",
      apiKey: "",
      model: "claude-opus-5-5",
      ollamaUrl: "",
      customEndpoint: "",
      apiMode: "chat_completions",
      maxContextSize: 200_000,
    }
    const { runDuplicateDetection } = await import("./dedup-runner")

    const result = await runDuplicateDetection(vault, llmConfig)

    const twins = TWINS.map(([a, b]) => ({
      twin: `${a} / ${b}`,
      sharedCalls: measured.calls.flatMap((pages, i) => (pages.includes(a) && pages.includes(b) ? [i] : [])),
      found: result.groups.some((g) => {
        const [sa, sb] = [slugOf(a), slugOf(b)]
        return sa === sb ? g.slugs.filter((s) => s === sa).length >= 2 : g.slugs.includes(sa) && g.slugs.includes(sb)
      }),
    }))
    const report = {
      candidatePairs: measured.pairs,
      clusters: measured.clusterSizes.length,
      largestClusters: measured.clusterSizes.slice(0, 5),
      detectorCalls: measured.batchSizes.length,
      largestBatches: [...measured.batchSizes].sort((x, y) => y - x).slice(0, 5),
      batchSizes: measured.batchSizes,
      groups: result.groups.length,
      failedBatches: result.failedBatches,
      twins,
      groupList: result.groups,
    }
    if (process.env.DEDUP_REPORT) await fs.writeFile(process.env.DEDUP_REPORT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...report, batchSizes: undefined, groupList: undefined }))

    expect(Math.max(...measured.batchSizes)).toBeLessThanOrEqual(80)
    expect(twins.filter((t) => t.found).length).toBeGreaterThanOrEqual(4)
  }, 4 * 60 * 60 * 1000)
})
