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
import { readFile, writeFile, fileExists, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { pagesNamed, type DuplicateGroup } from "@/lib/dedup"
import type { FileNode } from "@/types/wiki"

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

/** Replace the saved groups, for a scan that checked every page (#120). */
export async function replacePendingDuplicateGroups(
  projectPath: string,
  groups: DuplicateGroup[],
): Promise<void> {
  await editPendingGroups(() => savePendingDuplicateGroups(projectPath, groups))
}

/**
 * Add groups to the saved ones, for a scan that did not check every page
 * (#117). A saved group with the same pages as an added one is replaced by
 * it, and one naming a page no longer on disk is dropped (#120): a merge
 * of it would be refused.
 */
export async function addPendingDuplicateGroups(
  projectPath: string,
  groups: DuplicateGroup[],
): Promise<void> {
  const added = new Set(groups.map((g) => canonicalKey(g.slugs)))
  await editPendingGroups(async () => {
    const saved = await loadPendingDuplicateGroups(projectPath)
    const pages = await listWikiPages(projectPath)
    await savePendingDuplicateGroups(projectPath, [
      ...saved.filter((g) =>
        !added.has(canonicalKey(g.slugs))
        && g.slugs.every((slug) => pagesNamed(pages, slug).length > 0)),
      ...groups,
    ])
  })
}

/** Drop a group once the Maintenance screen has acted on it. */
export async function removePendingDuplicateGroup(
  projectPath: string,
  slugs: string[],
): Promise<void> {
  const key = canonicalKey(slugs)
  await editPendingGroups(async () => {
    const groups = await loadPendingDuplicateGroups(projectPath)
    const kept = groups.filter((g) => canonicalKey(g.slugs) !== key)
    if (kept.length !== groups.length) await savePendingDuplicateGroups(projectPath, kept)
  })
}

/** Read-modify-writes of the saved groups, one at a time, so the scheduled
 *  run adding groups and the Maintenance screen dropping one cannot undo
 *  each other's write (#117). */
let pendingEdits: Promise<unknown> = Promise.resolve()

function editPendingGroups(edit: () => Promise<void>): Promise<void> {
  const run = pendingEdits.then(edit)
  pendingEdits = run.catch(() => undefined)
  return run
}

/** The wiki's pages on disk: `file` as listed, `path` from the project
 *  root, as `pagesNamed` finds them. */
export async function listWikiPages(
  projectPath: string,
): Promise<{ file: string; path: string }[]> {
  const pp = normalizePath(projectPath)
  return [...walkFiles(await listDirectory(`${pp}/wiki`))]
    .map((node) => ({ file: node.path, path: normalizePath(node.path).slice(pp.length + 1) }))
}

function* walkFiles(nodes: FileNode[]): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) yield* walkFiles(node.children ?? [])
    else yield node
  }
}

function canonicalKey(slugs: string[]): string {
  return [...slugs].map((s) => s.toLowerCase()).sort().join(",")
}
