/**
 * The judge before a high-confidence merge (#145), end to end on pages
 * copied from a real vault: the real scheduled runMaintenanceTick, the real
 * runDuplicateDetection, the real high-group judge on the chat route and the
 * real executeMerge, each with the real Claude Code CLI on Opus through
 * `scripts/estate/live-cli.sh`, and the real merge queue. Embeddings are
 * off, so the detector sees every page in one call. The Tauri layer is
 * replaced as in the #135 live test: files through node:fs, the settings
 * store and the vector store in memory, the CLI's stdout lines handed to the
 * transport as the app's events.
 *
 * The pages are #111's (comment 6044112713): group 46, `todo-write` and
 * `todowrite`, two tools of one name in different products; groups 43 and
 * 44, an OpenClaw provider plugin with its vendor's page, `xai` and `z-ai`;
 * and two pairs of twins, Claude 3.7 Sonnet and the OpenClaw compaction
 * provider. Each is an entity page of the vault, copied with the vault's
 * index to a fresh project, so the copy itself is never written.
 *
 * Gated behind RUN_LLM_TESTS=1 and DEDUP_VAULT_COPY, the path of a copy
 * holding those pages. Writes its measurements to DEDUP_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { HIGH_GROUP_JUDGE_PROMPT_MARKER, type DuplicateGroup } from "./dedup"

const ENABLED = process.env.RUN_LLM_TESTS === "1" && !!process.env.DEDUP_VAULT_COPY

const LIVE_CLI = path.resolve(__dirname, "../../scripts/estate/live-cli.sh")

const storage = vi.hoisted(() => new Map<string, unknown>())
const measured = vi.hoisted(() => ({
  scans: [] as DuplicateGroup[][],
  merges: [] as { slugs: string[]; canonical: string; outcome: string }[],
  judgeCalls: [] as { pages: string[]; reply: string }[],
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

// The real scan and merge, watched so the test can read what the run saw
// and sent to the merge.
vi.mock("@/lib/dedup-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dedup-runner")>()
  return {
    ...actual,
    runDuplicateDetection: async (...args: Parameters<typeof actual.runDuplicateDetection>) => {
      const scan = await actual.runDuplicateDetection(...args)
      measured.scans.push(scan.groups)
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
 *  turn, the system text first. A high-group judge call is noted with its
 *  pages and the CLI's reply text. */
async function runCli(args: { streamId: string; messages: { role: string; content: string }[] }) {
  const system = args.messages.find((m) => m.role === "system")?.content ?? ""
  const user = args.messages.find((m) => m.role === "user")?.content ?? ""
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmw145-cli-"))
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
  if (system.includes(HIGH_GROUP_JUDGE_PROMPT_MARKER)) {
    const result = lines.map((l) => JSON.parse(l)).find((e) => e.type === "result")
    measured.judgeCalls.push({
      pages: [...user.matchAll(/^## Page: (.+)$/gm)].map((m) => m[1]),
      reply: String(result?.result ?? ""),
    })
  }
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

const PROJECT_ID = "llmw-145-copy"
const TWINS = [
  ["claude-3-7-sonnet", "claude-sonnet-3-7"],
  ["openclaw-compaction-provider", "openclaw-compaction-provider-api"],
]
const GROUP_46 = ["todo-write", "todowrite"]
const GROUPS_43_44 = [
  ["openclaw-xai-provider", "xai"],
  ["openclaw-zai-provider", "z-ai"],
]

describe.skipIf(!ENABLED)("the judge before a high-confidence merge, on #111's pages from a real vault (#145)", () => {
  it("merges the twins and not group 46, and records the verdict on groups 43 and 44", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    const { saveScheduledMaintenanceConfig } = await import("@/lib/project-store")
    const { restoreQueue, getQueue } = await import("./dedup-queue")
    const { listWikiPages, loadPendingDuplicateGroups, readNotDuplicates } = await import("./dedup-storage")
    const { pagesNamed } = await import("./dedup")
    const { runMaintenanceTick } = await import("./scheduled-maintenance")

    const fresh = await createTempProject("llmw145")
    try {
      await fs.mkdir(`${fresh.path}/wiki/entities`, { recursive: true })
      for (const slug of [...TWINS, GROUP_46, ...GROUPS_43_44].flat()) {
        await fs.copyFile(`${vault}/wiki/entities/${slug}.md`, `${fresh.path}/wiki/entities/${slug}.md`)
      }
      await fs.copyFile(`${vault}/wiki/index.md`, `${fresh.path}/wiki/index.md`)
      const project = { id: PROJECT_ID, name: "copy", path: fresh.path }
      storage.set("projectRegistry", { [PROJECT_ID]: { id: PROJECT_ID, path: fresh.path, name: "copy", lastOpened: Date.now() } })
      await saveScheduledMaintenanceConfig(fresh.path, { enabled: true, intervalHours: 24, lastRun: null })
      useWikiStore.setState({
        project,
        llmConfig: LLM_CONFIG,
        embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
      })
      await restoreQueue(PROJECT_ID, fresh.path)

      const record = await runMaintenanceTick(project, { now: () => Date.now() })
      const after = await listWikiPages(fresh.path)
      const notDuplicates = await readNotDuplicates(fresh.path)
      const pending = await loadPendingDuplicateGroups(fresh.path)

      const holds = (slugs: string[], pair: string[]) => pair.every((s) => slugs.includes(s))
      const outcome = (pair: string[]) => {
        const ids = pair.map((s) => `entities/${s}`)
        return {
          raisedAs: measured.scans.flat().filter((g) => holds(g.slugs, pair)).map((g) => g.confidence),
          judged: measured.judgeCalls.filter((c) => holds(c.pages, ids)),
          merge: measured.merges.find((m) => holds(m.slugs, pair)),
          recordedDistinct: notDuplicates.some((e) => holds(e, pair)),
          pending: pending.filter((g) => holds(g.slugs, pair)),
          pagesAfter: pair.flatMap((s) => pagesNamed(after, s).map((p) => p.path)),
        }
      }
      const report = {
        twins: TWINS.map((pair) => ({ pair, ...outcome(pair) })),
        group46: { pair: GROUP_46, ...outcome(GROUP_46) },
        groups43And44: GROUPS_43_44.map((pair) => ({ pair, ...outcome(pair) })),
        scans: measured.scans,
        judgeCalls: measured.judgeCalls,
        merges: measured.merges,
        record,
        notDuplicates,
        pending,
        queue: getQueue().map((t) => ({ slugs: t.group.slugs, status: t.status, error: t.error })),
      }
      if (process.env.DEDUP_REPORT) await fs.writeFile(process.env.DEDUP_REPORT, JSON.stringify(report, null, 2))

      // Each twin pair was judged one topic and merged into one page.
      for (const twin of report.twins) {
        expect(twin.judged, twin.pair.join()).toHaveLength(1)
        expect(twin.merge?.outcome, twin.pair.join()).toBe("merged")
        expect(twin.pagesAfter, twin.pair.join()).toHaveLength(1)
      }
      // Group 46 was raised high, judged, and not merged: both pages stay,
      // the pair is recorded as not duplicates, and the group is kept at
      // medium for the Maintenance screen.
      const g46 = report.group46
      expect(g46.raisedAs).toContain("high")
      expect(g46.judged).toHaveLength(1)
      expect(g46.merge).toBeUndefined()
      expect(g46.pagesAfter).toHaveLength(2)
      expect(g46.recordedDistinct).toBe(true)
      expect(g46.pending.map((g) => g.confidence)).toEqual(["medium"])
      expect(record?.failedDetectorBatches).toBeUndefined()
      expect(record?.mergesFailed ?? 0).toBe(0)
    } finally {
      await fresh.cleanup()
    }
  }, 60 * 60 * 1000)
})
