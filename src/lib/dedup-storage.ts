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
  try {
    return await readNotDuplicates(projectPath)
  } catch {
    return []
  }
}

/**
 * Like loadNotDuplicates, but a list that exists and cannot be read or
 * parsed throws instead of reading as empty. The scheduled job merges
 * with no click, so it must not take a broken list for "no pairs".
 */
export async function readNotDuplicates(projectPath: string): Promise<string[][]> {
  const filePath = `${normalizePath(projectPath)}/${FILE_NAME}`
  if (!(await fileExists(filePath))) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath))
  } catch (err) {
    throw new Error(`Cannot read the not-duplicates list ${FILE_NAME}: ${err}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Cannot read the not-duplicates list ${FILE_NAME}: not a list`)
  }
  return parsed.filter(
    (g): g is string[] =>
      Array.isArray(g) && g.every((s) => typeof s === "string"),
  )
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

/**
 * Add groups to the saved ones, for a scan that did not check every page
 * (#117). A saved group with the same pages as an added one is replaced by
 * it.
 */
export async function addPendingDuplicateGroups(
  projectPath: string,
  groups: DuplicateGroup[],
): Promise<void> {
  const added = new Set(groups.map((g) => canonicalKey(g.slugs)))
  const saved = await loadPendingDuplicateGroups(projectPath)
  await savePendingDuplicateGroups(projectPath, [
    ...saved.filter((g) => !added.has(canonicalKey(g.slugs))),
    ...groups,
  ])
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
