/**
 * The first scheduled run after install, on a copy of a real vault (#111):
 * the real runMaintenanceTick end to end – the duplicate scan with its
 * shared-slug judge (#135), then the merge queue and executeMerge, which
 * write to the copy – on the routes the run resolves from app-state: the
 * ingest route for the detector and merges, the chat route for the judge.
 * Broken links are counted with the app's structural lint before and after.
 *
 * Replaced: files through node:fs, listed as the app lists them
 * (dot-prefixed entries hidden, so page history is not taken for wiki
 * pages); the settings store in memory, seeded from app-state, so nothing
 * is written back; embeddings by a direct call to the endpoint; the vector
 * store by the fake one, with the vector backfill skipped, since vectors
 * are not what is measured; the Claude Code CLI run through
 * `scripts/estate/live-cli.sh`, its stdout lines handed to the transport as
 * the app's events. HTTP model calls go out through node's fetch; run with
 * NODE_OPTIONS="--dns-result-order=ipv4first
 * --network-family-autoselection-attempt-timeout=5000" (see the scan
 * preview).
 *
 * Gated behind RUN_LLM_TESTS=1, APP_STATE (only read; its key never leaves
 * this process) and PREVIEW_VAULT_COPY, a fresh
 * copy under the OS temp folder: the run changes it. Writes its report,
 * every high-confidence group with each page's title and first line, to
 * PREVIEW_MERGE_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appFs } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"
import {
  minutesSince,
  pagesFor,
  seedStoreFromAppState,
  tempVaultCopy,
  type SavedAppState,
} from "@/test-helpers/scheduled-preview"
import type { DuplicateScanResult } from "@/lib/dedup-runner"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1"
  && !!process.env.APP_STATE
  && !!process.env.PREVIEW_VAULT_COPY

const LIVE_CLI = path.resolve(__dirname, "../../scripts/estate/live-cli.sh")

const settings = vi.hoisted(() => new Map<string, unknown>())
/** The copy's real path, set once the guard has passed it. */
const vaultCopy = vi.hoisted(() => ({ path: "" }))
const measured = vi.hoisted(() => ({
  scan: null as DuplicateScanResult | null,
  calls: [] as { kind: "detector" | "judge" | "other"; pages?: number; seconds: number; error?: string }[],
}))
const vectors = createFakeVectorStore()
const listeners = new Map<string, (event: { payload: unknown }) => void>()

vi.mock("@/commands/fs", () => appFs)

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    get: async (key: string) => settings.get(key),
    set: async (key: string, value: unknown) => {
      settings.set(key, value)
    },
    delete: async (key: string) => {
      settings.delete(key)
    },
    save: async () => undefined,
  }),
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (topic: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(topic, handler)
    return () => listeners.delete(topic)
  },
}))

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
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
    if (cmd.startsWith("vector_")) return vectors.invoke(cmd, args)
    throw new Error(`unexpected invoke ${cmd}`)
  },
}))

vi.mock("@/lib/project-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-identity")>()),
  getProjectPathById: async () => vaultCopy.path,
}))

vi.mock("@/lib/dedup-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dedup-runner")>()
  return {
    ...actual,
    runDuplicateDetection: async (...args: Parameters<typeof actual.runDuplicateDetection>) => {
      measured.scan = await actual.runDuplicateDetection(...args)
      return measured.scan
    },
  }
})

vi.mock("@/lib/embedding-freshness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embedding-freshness")>()),
  runEmbeddingBackfill: async () => null,
}))

vi.mock("@/lib/llm-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm-client")>()
  const { JUDGE_PROMPT_MARKER } = await import("@/lib/dedup")
  return {
    ...actual,
    streamChat: async (...args: Parameters<typeof actual.streamChat>) => {
      const [config, messages, callbacks, signal, overrides] = args
      const system = String(messages.find((m) => m.role === "system")?.content ?? "")
      const user = String(messages.find((m) => m.role === "user")?.content ?? "")
      const batch = user.match(/Wiki pages to scan \((\d+) entries\)/)?.[1]
      const call: (typeof measured.calls)[number] = batch
        ? { kind: "detector", pages: Number(batch), seconds: 0 }
        : { kind: system.includes(JUDGE_PROMPT_MARKER) ? "judge" : "other", seconds: 0 }
      measured.calls.push(call)
      const started = Date.now()
      try {
        return await actual.streamChat(config, messages, {
          ...callbacks,
          onError: (err) => {
            call.error = err.message
            callbacks.onError(err)
          },
        }, signal, overrides)
      } finally {
        call.seconds = Math.round((Date.now() - started) / 1000)
        process.stderr.write(`model call ${measured.calls.length}: ${JSON.stringify(call)}\n`)
      }
    },
  }
})

/** As `build_claude_stdin` does for a system and a user message: one user
 *  turn, the system text first. */
async function runCli(args: { streamId: string; messages: { role: string; content: string }[] }) {
  const system = args.messages.find((m) => m.role === "system")?.content ?? ""
  const user = args.messages.find((m) => m.role === "user")?.content ?? ""
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmw111-cli-"))
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

describe.skipIf(!ENABLED)("the first scheduled run on a copy of a real vault", () => {
  it("scans and merges as the scheduled run would", async () => {
    const vault = await tempVaultCopy(process.env.PREVIEW_VAULT_COPY ?? "")
    vaultCopy.path = vault

    const state: SavedAppState & Record<string, unknown> = JSON.parse(await fs.readFile(process.env.APP_STATE ?? "", "utf8"))
    for (const [key, value] of Object.entries(state)) settings.set(key, value)
    // The live vault's schedule, keyed to the copy and due now.
    const live = Object.keys(state).find((k) => k.startsWith("scheduledMaintenanceConfig:"))
    settings.set(`scheduledMaintenanceConfig:${vault}`, { ...(live ? state[live] as object : {}), enabled: true, lastRun: null })
    const project = { id: "llmw-111-merge-copy", name: "copy", path: vault }
    seedStoreFromAppState(state, project)

    const { runStructuralLint } = await import("./lint")
    const { loadAllWikiPages } = await import("./dedup-runner")
    const brokenLinks = async () => (await runStructuralLint(vault)).filter((f) => f.type === "broken-link").length
    const pagesBefore = await loadAllWikiPages(vault)
    const before = { brokenLinks: await brokenLinks(), pages: pagesBefore.length }

    const { restoreQueue, getQueue } = await import("./dedup-queue")
    const { runMaintenanceTick } = await import("./scheduled-maintenance")
    await restoreQueue(project.id, vault)
    const started = Date.now()
    const record = await runMaintenanceTick(project, { now: Date.now })
    const minutes = minutesSince(started)

    const after = { brokenLinks: await brokenLinks(), pages: (await loadAllWikiPages(vault)).length }
    const groups = measured.scan?.groups ?? []
    const high = groups.filter((g) => g.confidence === "high")
    const detector = measured.calls.filter((c) => c.kind === "detector")
    const report = {
      minutes,
      before,
      after,
      calls: {
        detector: detector.length,
        largestBatch: Math.max(0, ...detector.map((c) => c.pages ?? 0)),
        judge: measured.calls.filter((c) => c.kind === "judge").length,
        other: measured.calls.filter((c) => c.kind === "other").length,
        errors: measured.calls.filter((c) => c.error),
      },
      record,
      highGroups: high.map((g, i) => ({
        group: i + 1,
        slugs: g.slugs,
        reason: g.reason,
        pages: [...new Set(g.slugs)].flatMap((slug) => pagesFor(slug, pagesBefore)),
      })),
      otherGroups: groups.filter((g) => g.confidence !== "high"),
      tasks: getQueue().map((t) => ({ slugs: t.group.slugs, canonical: t.canonicalSlug, status: t.status, error: t.error })),
    }
    if (process.env.PREVIEW_MERGE_REPORT) await fs.writeFile(process.env.PREVIEW_MERGE_REPORT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ minutes, before, after, calls: report.calls, record: { ...record, rejectedMerges: undefined } }))

    expect(record?.groupsFound).toBeDefined()
  }, 8 * 60 * 60 * 1000)
})
