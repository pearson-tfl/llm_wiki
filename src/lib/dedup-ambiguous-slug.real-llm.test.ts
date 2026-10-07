/**
 * Pages sharing a slug, settled by the judge with no one asked (#135), end
 * to end on pages copied from a real vault: the real scheduled
 * runMaintenanceTick, the real runDuplicateDetection and its judge with the
 * real Claude Code CLI on Opus through `scripts/estate/live-cli.sh`, the
 * real merge queue and the real executeMerge, which writes to the copy:
 * take a fresh copy for each run. Embeddings are off, so the detector sees
 * every page in one call. The Tauri layer is replaced: files through
 * node:fs, the settings store by an in-memory one, the vector store by an
 * in-memory one, and the CLI's stdout lines handed to the transport as the
 * app's events.
 *
 * The copy must hold the vault's two pairs, `agent-skills` and
 * `openclaw-code-mode`, each a concept and an entity page. The test adds a
 * third, built pair: `swarm`, a general idea and a product of that name,
 * which are two topics. A second run then shows a distinct verdict is not
 * asked again. The Maintenance screen's scan (`startDuplicateScan`) is run
 * first, on the pairs copied to a fresh project, so the copy is unchanged.
 *
 * Gated behind RUN_LLM_TESTS=1 and DEDUP_VAULT_COPY, the path of the copy.
 * Never point it at a live vault. Writes its measurements to DEDUP_REPORT
 * when set.
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

// The real scan and merge, watched so the test can read what each run
// saw and sent to the merge.
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
 *  turn, the system text first. A judge call is noted with its pages and
 *  the CLI's reply text. */
async function runCli(args: { streamId: string; messages: { role: string; content: string }[] }) {
  const system = args.messages.find((m) => m.role === "system")?.content ?? ""
  const user = args.messages.find((m) => m.role === "user")?.content ?? ""
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmw135-cli-"))
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

const PROJECT_ID = "llmw-135-copy"
const PAIRS = ["agent-skills", "openclaw-code-mode", "swarm"]

const SWARM_CONCEPT = `---
type: concept
title: Swarm
tags: [collective-behaviour, decentralised-control]
related: []
sources: ["swarm-intelligence-notes.md"]
created: 2026-10-07
updated: 2026-10-07
---
# Swarm

Swarm intelligence is the collective behaviour of many simple agents following local rules with no central controller, as in ant colonies, bird flocks and fish schools. Order emerges from interaction: no single agent holds the plan. Algorithms such as ant colony optimisation and particle swarm optimisation borrow the idea to search large solution spaces.
`

const SWARM_ENTITY = `---
type: entity
title: Swarm
tags: [openai, python, library, multi-agent]
related: []
sources: ["openai-swarm-readme.md"]
created: 2026-10-07
updated: 2026-10-07
---
# Swarm

Swarm is an experimental, educational Python library OpenAI published in October 2024 for orchestrating multiple agents. Its two primitives are agents, each with instructions and tools, and handoffs, where one agent passes the conversation to another. It runs client-side, keeps no state between calls, and was later succeeded by the OpenAI Agents SDK.
`

describe.skipIf(!ENABLED)("pages sharing a slug, on pages from a real vault, judged with no one asked (#135)", () => {
  it("the Maintenance screen's scan returns only groups naming pages by path, and records the distinct pair", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    const { startDuplicateScan } = await import("./dedup-runner")
    const { listWikiPages, readNotDuplicates } = await import("./dedup-storage")
    const { pagesNamed } = await import("./dedup")
    const fresh = await createTempProject("llmw135-screen")
    try {
      for (const slug of PAIRS.slice(0, 2)) {
        for (const folder of ["concepts", "entities"]) {
          await fs.mkdir(`${fresh.path}/wiki/${folder}`, { recursive: true })
          await fs.copyFile(`${vault}/wiki/${folder}/${slug}.md`, `${fresh.path}/wiki/${folder}/${slug}.md`)
        }
      }
      await fs.writeFile(`${fresh.path}/wiki/concepts/swarm.md`, SWARM_CONCEPT)
      await fs.writeFile(`${fresh.path}/wiki/entities/swarm.md`, SWARM_ENTITY)
      // The screen scans the open project.
      useWikiStore.setState({
        project: { id: "llmw-135-screen", name: "screen", path: fresh.path },
        llmConfig: LLM_CONFIG,
        embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
      })
      const judgeCallsBefore = measured.judgeCalls.length

      const result = await startDuplicateScan(fresh.path, LLM_CONFIG).done
      const pages = await listWikiPages(fresh.path)
      const notDuplicates = await readNotDuplicates(fresh.path)
      const screen = {
        groups: result?.groups,
        failedBatches: result?.failedBatches,
        judgeCalls: measured.judgeCalls.slice(judgeCallsBefore),
        notDuplicates,
      }
      if (process.env.DEDUP_REPORT) await fs.writeFile(`${process.env.DEDUP_REPORT}.screen.json`, JSON.stringify(screen, null, 2))

      expect(result?.failedBatches).toEqual([])
      expect(screen.judgeCalls).toHaveLength(3)
      for (const g of result?.groups ?? []) {
        expect(g.slugs.some((s) => pagesNamed(pages, s).length > 1), g.slugs.join()).toBe(false)
      }
      // Each real pair is offered as one group by path, or recorded distinct.
      for (const slug of PAIRS.slice(0, 2)) {
        const ids = [`concepts/${slug}`, `entities/${slug}`]
        const offered = result?.groups.some((g) => [...g.slugs].sort().join() === ids.join() && g.confidence === "high")
        const recorded = notDuplicates.some((e) => [...e].sort().join() === ids.join())
        expect(offered !== recorded, slug).toBe(true)
      }
      expect(notDuplicates).toContainEqual(["concepts/swarm", "entities/swarm"])
    } finally {
      await fresh.cleanup()
    }
  }, 30 * 60 * 1000)

  it("merges the pairs judged one topic, records the pair judged distinct, and asks nothing again", async () => {
    const vault = process.env.DEDUP_VAULT_COPY ?? ""
    const { saveScheduledMaintenanceConfig } = await import("@/lib/project-store")
    const { restoreQueue, getQueue } = await import("./dedup-queue")
    const { listWikiPages, loadPendingDuplicateGroups, readNotDuplicates } = await import("./dedup-storage")
    const { pagesNamed } = await import("./dedup")
    const { runMaintenanceTick } = await import("./scheduled-maintenance")

    await fs.writeFile(`${vault}/wiki/concepts/swarm.md`, SWARM_CONCEPT)
    await fs.writeFile(`${vault}/wiki/entities/swarm.md`, SWARM_ENTITY)
    const project = { id: PROJECT_ID, name: "copy", path: vault }
    storage.set("projectRegistry", { [PROJECT_ID]: { id: PROJECT_ID, path: vault, name: "copy", lastOpened: Date.now() } })
    await saveScheduledMaintenanceConfig(vault, { enabled: true, intervalHours: 24, lastRun: null })
    useWikiStore.setState({
      project,
      llmConfig: LLM_CONFIG,
      embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" },
    })
    await restoreQueue(PROJECT_ID, vault)
    const before = await listWikiPages(vault)
    for (const slug of PAIRS) expect(pagesNamed(before, slug), slug).toHaveLength(2)

    const judgeStart = measured.judgeCalls.length
    const first = await runMaintenanceTick(project, { now: () => Date.now() })
    const firstJudgeCalls = measured.judgeCalls.length - judgeStart
    const afterFirst = await listWikiPages(vault)
    const notDuplicates = await readNotDuplicates(vault)

    // Due again a day later, as the next scheduled run.
    const second = await runMaintenanceTick(project, { now: () => Date.now() + 25 * 60 * 60 * 1000 })
    const afterSecond = await listWikiPages(vault)
    const pending = await loadPendingDuplicateGroups(vault)

    const outcome = (slug: string) => {
      const ids = [`concepts/${slug}`, `entities/${slug}`]
      const merge = measured.merges.find((m) => [...m.slugs].sort().join() === ids.join())
      return {
        judged: measured.judgeCalls.slice(judgeStart).filter((c) => c.pages.some((p) => p.endsWith(`/${slug}`))),
        merge,
        recordedDistinct: notDuplicates.some((e) => [...e].sort().join() === ids.join()),
        pagesAfterFirstRun: pagesNamed(afterFirst, slug).map((p) => p.path),
      }
    }
    const report = {
      outcomes: Object.fromEntries(PAIRS.map((slug) => [slug, outcome(slug)])),
      scans: measured.scans,
      merges: measured.merges,
      firstRun: first,
      secondRun: second,
      judgeCallsFirstRun: firstJudgeCalls,
      judgeCallsSecondRun: measured.judgeCalls.length - judgeStart - firstJudgeCalls,
      notDuplicates,
      pending,
      queue: getQueue().map((t) => ({ slugs: t.group.slugs, status: t.status, error: t.error })),
    }
    if (process.env.DEDUP_REPORT) await fs.writeFile(process.env.DEDUP_REPORT, JSON.stringify(report, null, 2))

    // Each pair was judged once, and ended merged or recorded distinct.
    for (const slug of PAIRS) {
      const o = outcome(slug)
      expect(o.judged, slug).toHaveLength(1)
      if (o.merge) {
        expect(o.merge.outcome, slug).toBe("merged")
        expect(o.pagesAfterFirstRun, slug).toHaveLength(1)
        expect(o.recordedDistinct, slug).toBe(false)
      } else {
        expect(o.recordedDistinct, slug).toBe(true)
        expect(o.pagesAfterFirstRun, slug).toHaveLength(2)
      }
    }
    // The built pair is two topics, so it is not merged.
    expect(outcome("swarm").merge).toBeUndefined()
    expect(pagesNamed(afterSecond, "swarm")).toHaveLength(2)
    // Nothing of this kind is left for anyone, and the second run asks no
    // judge again.
    for (const scan of measured.scans) {
      for (const g of scan) expect(g.slugs.some((s) => pagesNamed(afterFirst, s).length > 1), g.slugs.join()).toBe(false)
    }
    expect(pending.filter((g) => g.slugs.some((s) => PAIRS.some((slug) => s.endsWith(slug))))).toEqual([])
    expect(report.judgeCallsSecondRun).toBe(0)
    expect(first?.mergesFailed ?? 0).toBe(0)
    expect(first?.failedDetectorBatches).toBeUndefined()
    expect(getQueue().filter((t) => t.status === "failed")).toEqual([])
  }, 60 * 60 * 1000)
})
