/**
 * Two duplicate groups of one scan that share pages (#149), end to end on
 * the pages John's scheduled run merged on 2026-10-08: the real scheduled
 * runMaintenanceTick, the real runDuplicateDetection, the real judges on
 * the chat route and the real executeMerge, each with the real Claude Code
 * CLI on Opus through `scripts/estate/live-cli.sh`, and the real merge
 * queue. Embeddings are off, so the detector sees every page in one call.
 * The Tauri layer is replaced as in #145's live test.
 *
 * The pages are `concepts/agent-skills` and `entities/agent-skills` as that
 * run's first merge backed them up, before it removed the first, and
 * `entities/agentskills-spec`, with the vault's index, copied to a fresh
 * project, so the copy is never written. That run queued the shared-slug
 * pair and the trio holding it; the pair merged first, and the trio failed
 * every retry on the page the pair's merge removed. The scan here is not
 * steered: whichever groups it finds are queued as the run queues them.
 * A second run queues the same two groups through the real queue, the trio
 * only once the pair's merge is done, as the scheduled run does when a
 * judge call between them outlasts the merge.
 *
 * Gated behind RUN_LLM_TESTS=1 and DEDUP_VAULT_COPY, the path of a copy
 * holding those pages under `wiki/`. Writes its measurements to
 * DEDUP_REPORT when set.
 */
import { describe, expect, it, vi } from "vitest"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"
import { JUDGE_PROMPT_MARKER, type DuplicateGroup } from "./dedup"

const ENABLED = process.env.RUN_LLM_TESTS === "1" && !!process.env.DEDUP_VAULT_COPY

const LIVE_CLI = path.resolve(__dirname, "../../scripts/estate/live-cli.sh")

const storage = vi.hoisted(() => new Map<string, unknown>())
const measured = vi.hoisted(() => ({
  scans: [] as DuplicateGroup[][],
  enqueued: [] as { slugs: string[]; canonical: string }[],
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

// The real scan and merge, watched so the test can read what the run found
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

// The real queue, watched so the test can read every group the run queued,
// whether or not its merge ends up calling the model.
vi.mock("@/lib/dedup-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dedup-queue")>()
  return {
    ...actual,
    enqueueMerge: async (...args: Parameters<typeof actual.enqueueMerge>) => {
      measured.enqueued.push({ slugs: args[1].slugs, canonical: args[2] })
      return actual.enqueueMerge(...args)
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
 *  turn, the system text first. A judge call is noted with its
 *  pages and the CLI's reply text. */
async function runCli(args: { streamId: string; messages: { role: string; content: string }[] }) {
  const system = args.messages.find((m) => m.role === "system")?.content ?? ""
  const user = args.messages.find((m) => m.role === "user")?.content ?? ""
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmw149-cli-"))
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
  if (system.includes(JUDGE_PROMPT_MARKER)) {
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

const PROJECT_ID = "llmw-149-copy"
const PAGES = ["concepts/agent-skills", "entities/agent-skills", "entities/agentskills-spec"]

describe.skipIf(!ENABLED)("two groups of one scan that share pages, on the agent-skills pages of John's vault (#149)", () => {
  it("queues groups that share a page and merges them all, with no failed task", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    const { saveScheduledMaintenanceConfig } = await import("@/lib/project-store")
    const { restoreQueue, getQueue } = await import("./dedup-queue")
    const { listWikiPages } = await import("./dedup-storage")
    const { runMaintenanceTick } = await import("./scheduled-maintenance")

    const fresh = await createTempProject("llmw149")
    try {
      for (const page of [...PAGES.map((id) => `wiki/${id}.md`), "wiki/index.md"]) {
        await fs.mkdir(path.dirname(`${fresh.path}/${page}`), { recursive: true })
        await fs.copyFile(`${vault}/${page}`, `${fresh.path}/${page}`)
      }
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
      const pagesAfter = (await listWikiPages(fresh.path)).map((p) => p.path).filter((p) => p !== "wiki/index.md")
      const shared = measured.enqueued.flatMap((a, i) =>
        measured.enqueued.slice(i + 1).flatMap((b) => a.slugs.filter((s) => b.slugs.includes(s))))
      const report = {
        scans: measured.scans,
        judgeCalls: measured.judgeCalls,
        enqueued: measured.enqueued,
        merges: measured.merges,
        sharedPagesBetweenQueuedGroups: [...new Set(shared)],
        pagesAfter,
        record,
        queue: getQueue().map((t) => ({ slugs: t.group.slugs, status: t.status, retryCount: t.retryCount, error: t.error })),
      }
      if (process.env.DEDUP_REPORT) await fs.writeFile(process.env.DEDUP_REPORT, JSON.stringify(report, null, 2))

      // The overlap reproduced: the run queued two groups that share a page.
      expect(report.sharedPagesBetweenQueuedGroups.length).toBeGreaterThan(0)
      // Every queued merge settled as done, none failed, and no task is left.
      expect(record?.mergesEnqueued).toBe(measured.enqueued.length)
      expect(record?.mergesDone).toBe(measured.enqueued.length)
      expect(record?.mergesFailed ?? 0).toBe(0)
      expect(measured.merges.map((m) => m.outcome).filter((o) => o !== "merged")).toEqual([])
      expect(report.queue).toEqual([])
      // The pages the queued groups joined are one page now.
      const joined = new Set(measured.enqueued.flatMap((g) => g.slugs))
      expect(pagesAfter.filter((p) => joined.has(p.replace(/^wiki\//, "").replace(/\.md$/, "")))).toHaveLength(1)
    } finally {
      await fresh.cleanup()
    }
  }, 60 * 60 * 1000)

  it("merges the trio queued only after the pair's merge removed one of its pages", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    const { enqueueMerge, restoreQueue, getQueue, waitForTask } = await import("./dedup-queue")
    const { listWikiPages } = await import("./dedup-storage")

    const fresh = await createTempProject("llmw149-after")
    try {
      for (const page of [...PAGES.map((id) => `wiki/${id}.md`), "wiki/index.md"]) {
        await fs.mkdir(path.dirname(`${fresh.path}/${page}`), { recursive: true })
        await fs.copyFile(`${vault}/${page}`, `${fresh.path}/${page}`)
      }
      const projectId = `${PROJECT_ID}-after`
      storage.set("projectRegistry", { [projectId]: { id: projectId, path: fresh.path, name: "after", lastOpened: Date.now() } })
      useWikiStore.setState({
        project: { id: projectId, name: "after", path: fresh.path },
        llmConfig: LLM_CONFIG,
        embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
      })
      await restoreQueue(projectId, fresh.path)
      const mergesBefore = measured.merges.length

      // The two groups John's run queued on 2026-10-08, the trio queued as
      // the scheduled run would once a judge call had taken longer than
      // the pair's merge.
      const pairOutcome = await waitForTask(await enqueueMerge(projectId, {
        slugs: ["concepts/agent-skills", "entities/agent-skills"], reason: "Judged one topic", confidence: "high", judged: true,
      }, "entities/agent-skills", { scheduled: true }))
      const trioOutcome = await waitForTask(await enqueueMerge(projectId, {
        slugs: ["entities/agent-skills", "concepts/agent-skills", "entities/agentskills-spec"], reason: "Judged one topic", confidence: "high", judged: true,
      }, "entities/agent-skills", { scheduled: true }))
      const pagesAfter = (await listWikiPages(fresh.path)).map((p) => p.path).filter((p) => p !== "wiki/index.md")
      const report = {
        pairOutcome,
        trioOutcome,
        merges: measured.merges.slice(mergesBefore),
        pagesAfter,
        queue: getQueue().map((t) => ({ slugs: t.group.slugs, status: t.status, retryCount: t.retryCount, error: t.error })),
      }
      if (process.env.DEDUP_REPORT) await fs.writeFile(`${process.env.DEDUP_REPORT}.after.json`, JSON.stringify(report, null, 2))

      expect(pairOutcome).toBe("done")
      expect(trioOutcome).toBe("done")
      expect(report.merges.map((m) => [m.slugs, m.outcome])).toEqual([
        [["concepts/agent-skills", "entities/agent-skills"], "merged"],
        [["entities/agent-skills", "entities/agentskills-spec"], "merged"],
      ])
      expect(pagesAfter).toEqual(["wiki/entities/agent-skills.md"])
      expect(report.queue).toEqual([])
    } finally {
      await fresh.cleanup()
    }
  }, 30 * 60 * 1000)
})
