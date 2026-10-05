/**
 * Scheduled maintenance job (#16 fix 2, ticket #18): a per-project timer
 * that runs the existing duplicate scan with no click. Started and stopped
 * the same way as scheduled import, for the open project only.
 */
import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  loadScheduledMaintenanceConfig,
  saveScheduledMaintenanceConfig,
  type ScheduledMaintenanceConfig,
} from "@/lib/project-store"
import { runDuplicateDetection } from "@/lib/dedup-runner"
import { sweepResolvedReviews } from "@/lib/sweep-reviews"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { getQueueSummary as getIngestQueueSummary } from "@/lib/ingest-queue"
import { enqueueMerge, waitForTask } from "@/lib/dedup-queue"
import {
  holdsNotDuplicate,
  loadNotDuplicates,
  savePendingDuplicateGroups,
} from "@/lib/dedup-storage"
import { parseFrontmatter } from "@/lib/frontmatter"
import { parseSources } from "@/lib/sources-merge"
import type { DuplicateGroup } from "@/lib/dedup"
import type { FileNode, WikiProject } from "@/types/wiki"

const RUN_RECORD_PATH = ".llm-wiki/maintenance-runs.jsonl"

export type MaintenanceSkipReason = "ingest-busy" | "previous-tick-running" | "no-model"

let tickRunning = false

export interface MaintenanceRunRecord {
  startedAt: string
  finishedAt: string
  skipReason: MaintenanceSkipReason | null
  groupsFound?: { high: number; medium: number; low: number }
  mergesEnqueued?: number
  mergesDone?: number
  mergesFailed?: number
}

export function isMaintenanceDue(config: ScheduledMaintenanceConfig, now: number): boolean {
  if (!config.enabled || config.intervalHours <= 0) return false
  if (config.lastRun === null) return true
  return now - config.lastRun >= config.intervalHours * 60 * 60 * 1000
}

/**
 * One tick of the job. Returns null when the job is not due by `now`;
 * otherwise the run record it appended.
 */
export async function runMaintenanceTick(
  project: WikiProject,
  clock: { now: () => number },
): Promise<MaintenanceRunRecord | null> {
  const pp = normalizePath(project.path)
  const config = await loadScheduledMaintenanceConfig(pp)
  const startedAt = clock.now()
  if (!isMaintenanceDue(config, startedAt)) return null

  const llmConfig = getTaskLlmConfig("ingest")
  const ingest = getIngestQueueSummary()
  // No await between this check and setting the flag, so two ticks can
  // never both pass it.
  const skipReason: MaintenanceSkipReason | null = tickRunning
    ? "previous-tick-running"
    : ingest.pending + ingest.processing > 0
      ? "ingest-busy"
      : !hasUsableLlm(llmConfig)
        ? "no-model"
        : null
  if (skipReason) {
    // A skip is not a run: lastRun stays put, so the job stays due.
    return appendRunRecord(pp, {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(clock.now()).toISOString(),
      skipReason,
    })
  }

  tickRunning = true
  try {
    const groups = await runDuplicateDetection(pp, llmConfig)
    const notDuplicates = await loadNotDuplicates(pp)
    // Only high-confidence groups merge with no click. A group holding a
    // pair marked "not duplicates" is left for a decision by hand.
    const toMerge = groups.filter(
      (g) => g.confidence === "high" && !holdsNotDuplicate(g.slugs, notDuplicates),
    )
    await savePendingDuplicateGroups(pp, groups.filter((g) => !toMerge.includes(g)))

    const outcomes: Promise<string>[] = []
    for (const group of toMerge) {
      const canonical = await chooseCanonicalSlug(pp, group)
      const taskId = await enqueueMerge(project.id, group, canonical, { scheduled: true })
      outcomes.push(waitForTask(taskId))
    }
    const settled = await Promise.all(outcomes)
    const mergesDone = settled.filter((o) => o === "done").length
    // Close review items whose pages the merges removed.
    if (mergesDone > 0) await sweepResolvedReviews(pp)

    // Later steps run here, after the duplicate scan.

    await saveScheduledMaintenanceConfig(pp, { ...config, lastRun: startedAt })
    return await appendRunRecord(pp, {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(clock.now()).toISOString(),
      skipReason: null,
      groupsFound: {
        high: groups.filter((g) => g.confidence === "high").length,
        medium: groups.filter((g) => g.confidence === "medium").length,
        low: groups.filter((g) => g.confidence === "low").length,
      },
      mergesEnqueued: outcomes.length,
      mergesDone,
      mergesFailed: settled.length - mergesDone,
    })
  } finally {
    tickRunning = false
  }
}

async function appendRunRecord(
  pp: string,
  record: MaintenanceRunRecord,
): Promise<MaintenanceRunRecord> {
  const path = `${pp}/${RUN_RECORD_PATH}`
  let existing = ""
  try {
    existing = await readFile(path)
  } catch {
    // first run: no record file yet
  }
  await writeFile(path, `${existing}${JSON.stringify(record)}\n`)
  return record
}

/**
 * The page a group merges into: most sources, then earliest created date,
 * then first in the group. Slugs resolve to pages by basename anywhere
 * under wiki/, as executeMerge resolves them.
 */
async function chooseCanonicalSlug(pp: string, group: DuplicateGroup): Promise<string> {
  const paths = new Map<string, string>()
  for (const file of walkFiles(await listDirectory(`${pp}/wiki`))) {
    if (file.name.endsWith(".md")) paths.set(file.name.slice(0, -3), file.path)
  }
  const ranked = await Promise.all(
    group.slugs.map(async (slug, position) => {
      const path = paths.get(slug)
      const content = path ? await readFile(path).catch(() => "") : ""
      const created = Date.parse(String(parseFrontmatter(content).frontmatter?.created ?? ""))
      return {
        slug,
        position,
        sources: parseSources(content).length,
        created: Number.isNaN(created) ? Infinity : created,
      }
    }),
  )
  ranked.sort((a, b) =>
    b.sources - a.sources || a.created - b.created || a.position - b.position,
  )
  return ranked[0].slug
}

function* walkFiles(nodes: FileNode[]): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) yield* walkFiles(node.children ?? [])
    else yield node
  }
}
