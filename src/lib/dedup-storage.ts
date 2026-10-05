/**
 * Persistence for the dedup tool's "not duplicates" whitelist.
 *
 * When the user reviews a candidate group and says "these are NOT
 * the same thing", we record the group so the next detector run
 * doesn't re-suggest it. Stored as a JSON array-of-arrays where
 * each inner array is one whitelisted group of slugs (lowercased,
 * sorted — see the canonical key logic in `dedup.ts`).
 *
 * Lives next to ingest-cache.json / image-caption-cache.json /
 * lexical-graph.json (when added) — same `.llm-wiki/` directory,
 * same JSON-on-disk pattern.
 */
import { readFile, writeFile, fileExists } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { DuplicateGroup } from "@/lib/dedup"

const FILE_NAME = ".llm-wiki/dedup-not-duplicates.json"
/** Groups the scheduled scan found but did not merge, kept for the
 *  Maintenance screen's manual actions. */
const PENDING_GROUPS_FILE = ".llm-wiki/dedup-pending-groups.json"

export async function loadNotDuplicates(projectPath: string): Promise<string[][]> {
  const pp = normalizePath(projectPath)
  const filePath = `${pp}/${FILE_NAME}`
  try {
    if (!(await fileExists(filePath))) return []
  } catch {
    return []
  }
  try {
    const content = await readFile(filePath)
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (g): g is string[] =>
        Array.isArray(g) && g.every((s) => typeof s === "string"),
    )
  } catch {
    return []
  }
}

export async function saveNotDuplicates(
  projectPath: string,
  list: string[][],
): Promise<void> {
  const pp = normalizePath(projectPath)
  await writeFile(`${pp}/${FILE_NAME}`, JSON.stringify(list, null, 2))
}

/**
 * Add a group to the whitelist. Idempotent — if the same group
 * (in any order, any casing) is already present, this is a no-op.
 */
export async function addNotDuplicate(
  projectPath: string,
  slugs: string[],
): Promise<void> {
  if (slugs.length < 2) return
  const list = await loadNotDuplicates(projectPath)
  const normNew = canonicalKey(slugs)
  for (const existing of list) {
    if (canonicalKey(existing) === normNew) return // already there
  }
  list.push([...slugs].sort())
  await saveNotDuplicates(projectPath, list)
}

/** True when every slug of some not-duplicates entry is in `slugs`. */
export function holdsNotDuplicate(slugs: string[], notDuplicates: string[][]): boolean {
  const inGroup = new Set(slugs.map((s) => s.toLowerCase()))
  return notDuplicates.some((entry) => entry.every((s) => inGroup.has(s.toLowerCase())))
}

export async function loadPendingDuplicateGroups(projectPath: string): Promise<DuplicateGroup[]> {
  try {
    const parsed = JSON.parse(await readFile(`${normalizePath(projectPath)}/${PENDING_GROUPS_FILE}`))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function savePendingDuplicateGroups(
  projectPath: string,
  groups: DuplicateGroup[],
): Promise<void> {
  await writeFile(
    `${normalizePath(projectPath)}/${PENDING_GROUPS_FILE}`,
    JSON.stringify(groups, null, 2),
  )
}

/** Drop a group once the Maintenance screen has acted on it. */
export async function removePendingDuplicateGroup(
  projectPath: string,
  slugs: string[],
): Promise<void> {
  const groups = await loadPendingDuplicateGroups(projectPath)
  const key = canonicalKey(slugs)
  const kept = groups.filter((g) => canonicalKey(g.slugs) !== key)
  if (kept.length !== groups.length) await savePendingDuplicateGroups(projectPath, kept)
}

function canonicalKey(slugs: string[]): string {
  return [...slugs].map((s) => s.toLowerCase()).sort().join(",")
}
