/**
 * The scheduled run's merges on a copy of a real vault (#111): the real
 * runMaintenanceTick, merge queue and executeMerge, on the model the
 * scheduled run resolves from app-state, given the groups a preview scan
 * found (scheduled-dedup-preview.real-llm.test.ts) in place of a second
 * scan. Broken links are counted with the app's structural lint before and
 * after.
 *
 * Replaced: files through node:fs; the settings store in memory, seeded
 * from app-state, so nothing is written back; the vector store with the
 * fake one, and the vector backfill skipped, since vectors are not what is
 * measured. A hub-rebuild request in the copy would run as it does live.
 *
 * Gated behind RUN_LLM_TESTS=1, APP_STATE, PREVIEW_SCAN_REPORT (the scan's
 * report) and PREVIEW_VAULT_COPY, a copy under the OS temp folder taken
 * from the same snapshot the scan read. Writes to PREVIEW_MERGE_REPORT
 * when set.
 */
import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"
import { minutesSince, seedStoreFromAppState, tempVaultCopy } from "@/test-helpers/scheduled-preview"
import type { DuplicateGroup } from "@/lib/dedup"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1"
  && !!process.env.APP_STATE
  && !!process.env.PREVIEW_SCAN_REPORT
  && !!process.env.PREVIEW_VAULT_COPY

const settings = vi.hoisted(() => new Map<string, unknown>())
/** The copy's real path, set once the guard has passed it. */
const copy = vi.hoisted(() => ({ path: "" }))
const scan = vi.hoisted(() => ({ groups: [] as DuplicateGroup[], failedBatches: [] as unknown[], notDone: undefined as unknown }))
const vectors = createFakeVectorStore()

vi.mock("@/commands/fs", () => realFs)

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

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: (cmd: string, args?: Record<string, unknown>) => vectors.invoke(cmd, args),
}))

vi.mock("@/lib/project-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-identity")>()),
  getProjectPathById: async () => copy.path,
}))

vi.mock("@/lib/dedup-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dedup-runner")>()),
  runDuplicateDetection: async () => scan,
}))

vi.mock("@/lib/embedding-freshness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embedding-freshness")>()),
  runEmbeddingBackfill: async () => null,
}))

describe.skipIf(!ENABLED)("the scheduled merges on a copy of a real vault", () => {
  it("merges the preview's high-confidence groups as the scheduled run would", async () => {
    const vault = await tempVaultCopy(process.env.PREVIEW_VAULT_COPY ?? "")
    copy.path = vault

    const state = JSON.parse(await fs.readFile(process.env.APP_STATE ?? "", "utf8"))
    for (const [key, value] of Object.entries(state)) settings.set(key, value)
    // The live vault's schedule, keyed to the copy and due now.
    const live = Object.keys(state).find((k) => k.startsWith("scheduledMaintenanceConfig:"))
    settings.set(`scheduledMaintenanceConfig:${vault}`, { ...(live ? state[live] : {}), enabled: true, lastRun: null })
    const project = { id: "llmw-111-merge-copy", name: "copy", path: vault }
    seedStoreFromAppState(state, project)

    const preview = JSON.parse(await fs.readFile(process.env.PREVIEW_SCAN_REPORT ?? "", "utf8"))
    scan.groups = [
      ...preview.highGroups.map((g: { slugs: string[]; reason: string }) => ({ slugs: g.slugs, reason: g.reason, confidence: "high" })),
      ...preview.otherGroups,
    ]
    scan.failedBatches = preview.failedBatches
    scan.notDone = preview.notDone ?? undefined

    const { runStructuralLint } = await import("./lint")
    const brokenLinks = async () => (await runStructuralLint(vault)).filter((f) => f.type === "broken-link").length
    const pageCount = async () => (await fs.readdir(path.join(vault, "wiki"), { recursive: true }))
      .filter((f) => String(f).endsWith(".md")).length
    const before = { brokenLinks: await brokenLinks(), pages: await pageCount() }

    const { restoreQueue, getQueue } = await import("./dedup-queue")
    const { runMaintenanceTick } = await import("./scheduled-maintenance")
    await restoreQueue(project.id, vault)
    const started = Date.now()
    const record = await runMaintenanceTick(project, { now: Date.now })
    const minutes = minutesSince(started)

    const after = { brokenLinks: await brokenLinks(), pages: await pageCount() }
    const report = {
      minutes,
      before,
      after,
      record,
      tasks: getQueue().map((t) => ({ slugs: t.group.slugs, canonical: t.canonicalSlug, status: t.status, error: t.error })),
    }
    if (process.env.PREVIEW_MERGE_REPORT) await fs.writeFile(process.env.PREVIEW_MERGE_REPORT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ minutes, before, after, record: { ...record, rejectedMerges: undefined } }))

    expect(record?.skipReason).toBeNull()
  }, 8 * 60 * 60 * 1000)
})
