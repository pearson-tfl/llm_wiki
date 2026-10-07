/**
 * A high-confidence group naming a slug that two pages share (#114), end to
 * end on pages copied from a real vault: the real scheduled
 * runMaintenanceTick, the real runDuplicateDetection with the real Claude
 * Code CLI through `scripts/estate/live-cli.sh`, the real merge queue and
 * the real executeMerge, which writes to the copy: take a fresh copy for
 * each run. Embeddings are off, so the detector sees every page in one
 * call. The Tauri layer is replaced: files through node:fs, the settings
 * store by an in-memory one, the vector store by an in-memory one, and the
 * CLI's stdout lines handed to the transport as the app's events.
 *
 * Gated behind RUN_LLM_TESTS=1 and DEDUP_VAULT_COPY, the path of the copy,
 * which must hold a concept and an entity page of one slug. Never point it
 * at a live vault. Writes its measurements to DEDUP_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { realFs } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import type { DuplicateGroup } from "./dedup"

const ENABLED = process.env.RUN_LLM_TESTS === "1" && !!process.env.DEDUP_VAULT_COPY

const LIVE_CLI = path.resolve(__dirname, "../../scripts/estate/live-cli.sh")

const storage = vi.hoisted(() => new Map<string, unknown>())
const measured = vi.hoisted(() => ({
  scanned: [] as DuplicateGroup[],
  merges: [] as { slugs: string[]; canonical: string; outcome: string }[],
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

// The real scan and merge, watched so the test can read what the tick saw
// and sent to the merge.
vi.mock("@/lib/dedup-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dedup-runner")>()
  return {
    ...actual,
    runDuplicateDetection: async (...args: Parameters<typeof actual.runDuplicateDetection>) => {
      const scan = await actual.runDuplicateDetection(...args)
      measured.scanned = scan.groups
      return scan
    },
    executeMerge: async (...args: Parameters<typeof actual.executeMerge>) => {
      const entry = { slugs: args[1].slugs, canonical: args[2], outcome: "" }
      measured.merges.push(entry)
      try {
        const result = await actual.executeMerge(...args)
        entry.outcome = "merged"
        return result
      } catch (err) {
        entry.outcome = err instanceof Error ? err.message : String(err)
        throw err
      }
    },
  }
})

const vectors = createFakeVectorStore()
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
      if (cmd === "claude_cli_spawn") {
        void runCli(args as { streamId: string; messages: { role: string; content: string }[] })
        return undefined
      }
      if (cmd === "claude_cli_kill") return undefined
      if (cmd.startsWith("vector_")) return vectors.invoke(cmd, args)
      throw new Error(`unexpected invoke ${cmd}`)
    },
  }
})

/** As `build_claude_stdin` does for a system and a user message: one user
 *  turn, the system text first. */
async function runCli(args: { streamId: string; messages: { role: string; content: string }[] }) {
  const system = args.messages.find((m) => m.role === "system")?.content ?? ""
  const user = args.messages.find((m) => m.role === "user")?.content ?? ""
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmw114-cli-"))
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

const LLM_CONFIG: LlmConfig = {
  provider: "claude-code",
  apiKey: "",
  model: "claude-opus-5-5",
  ollamaUrl: "",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxContextSize: 200_000,
}

const PROJECT_ID = "llmw-114-copy"

describe.skipIf(!ENABLED)("a high-confidence group naming a shared slug, on pages from a real vault (#114)", () => {
  it("is saved for the Maintenance screen and never reaches the merge; every other high group merges", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    const { saveScheduledMaintenanceConfig } = await import("@/lib/project-store")
    const { restoreQueue, getQueue } = await import("./dedup-queue")
    const { loadPendingDuplicateGroups } = await import("./dedup-storage")
    const { listDirectory } = await import("@/commands/fs")
    const { pagesNamed } = await import("./dedup")
    const { runMaintenanceTick } = await import("./scheduled-maintenance")

    const project = { id: PROJECT_ID, name: "copy", path: vault }
    storage.set("projectRegistry", { [PROJECT_ID]: { id: PROJECT_ID, path: vault, name: "copy", lastOpened: Date.now() } })
    await saveScheduledMaintenanceConfig(vault, { enabled: true, intervalHours: 24, lastRun: null })
    useWikiStore.setState({
      project,
      llmConfig: LLM_CONFIG,
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    })
    await restoreQueue(PROJECT_ID, vault)

    // The copy's pages, as the merge reads them.
    const walk = (nodes: Awaited<ReturnType<typeof listDirectory>>): string[] =>
      nodes.flatMap((n) => (n.is_dir ? walk(n.children ?? []) : [n.path.slice(vault.length + 1)]))
    const pages = walk(await listDirectory(`${vault}/wiki`)).map((p) => ({ path: p }))
    const namesTwo = (g: DuplicateGroup) => g.slugs.some((s) => pagesNamed(pages, s).length > 1)

    const record = await runMaintenanceTick(project, { now: () => Date.now() })

    const highShared = measured.scanned.filter((g) => g.confidence === "high" && namesTwo(g))
    const highClear = measured.scanned.filter((g) => g.confidence === "high" && !namesTwo(g))
    const pending = await loadPendingDuplicateGroups(vault)
    const report = {
      scanned: measured.scanned,
      highShared,
      merges: measured.merges,
      record,
      pending,
      queue: getQueue().map((t) => ({ slugs: t.group.slugs, status: t.status, error: t.error })),
    }
    if (process.env.DEDUP_REPORT) await fs.writeFile(process.env.DEDUP_REPORT, JSON.stringify(report, null, 2))

    // The model named a shared slug bare in a high group, so the run proves
    // the case; a run where it did not proves nothing and fails here.
    expect(highShared.length).toBeGreaterThan(0)
    for (const g of highShared) {
      expect(pending).toContainEqual(g)
      expect(measured.merges.map((m) => m.slugs)).not.toContainEqual(g.slugs)
    }
    expect(measured.merges.map((m) => m.slugs)).toEqual(highClear.map((g) => g.slugs))
    expect(record?.mergesEnqueued).toBe(highClear.length)
    expect(getQueue().filter((t) => t.status === "failed")).toEqual([])
  }, 30 * 60 * 1000)
})
