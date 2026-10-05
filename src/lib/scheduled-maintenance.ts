/**
 * Scheduled maintenance job (#16 fix 2, ticket #18): a per-project timer
 * that runs the existing duplicate scan with no click. Started and stopped
 * the same way as scheduled import, for the open project only.
 */
import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  loadScheduledMaintenanceConfig,
  saveScheduledMaintenanceConfig,
  type ScheduledMaintenanceConfig,
} from "@/lib/project-store"
import { runDuplicateDetection } from "@/lib/dedup-runner"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"
import type { WikiProject } from "@/types/wiki"

const RUN_RECORD_PATH = ".llm-wiki/maintenance-runs.jsonl"

export interface MaintenanceRunRecord {
  startedAt: string
  finishedAt: string
  skipReason: string | null
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

  await runDuplicateDetection(pp, getTaskLlmConfig("ingest"))
  await saveScheduledMaintenanceConfig(pp, { ...config, lastRun: startedAt })

  const record: MaintenanceRunRecord = {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(clock.now()).toISOString(),
    skipReason: null,
  }
  await appendRunRecord(pp, record)
  return record
}

async function appendRunRecord(pp: string, record: MaintenanceRunRecord): Promise<void> {
  const path = `${pp}/${RUN_RECORD_PATH}`
  let existing = ""
  try {
    existing = await readFile(path)
  } catch {
    // first run: no record file yet
  }
  await writeFile(path, `${existing}${JSON.stringify(record)}\n`)
}
