/**
 * Keeping the vector index fresh (#67): the scheduled maintenance tick's
 * coverage check and backfill, and the re-embed after a duplicate merge
 * or a hub rebuild. A failed embed is logged and recorded, never thrown,
 * so it cannot fail the work that triggered it; the page keeps its old
 * recorded hash, so the next backfill tries it again.
 */
import { fileExists, listDirectory, readFile, writeFile } from "@/commands/fs"
import {
  contentPagesInTree,
  embedPage,
  type EmbeddedHashes,
  extractEmbeddingTitle,
  fetchEmbedding,
  getLastEmbeddingError,
  hasEmbeddableText,
  isContentPagePath,
  listVectorPageIds,
  loadEmbeddedHashes,
  recordEmbeddedHashes,
  removePageEmbedding,
  removeVectorPageId,
  wikiPageIdFromPath,
} from "@/lib/embedding"
import { sha256 } from "@/lib/ingest-cache"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore, type EmbeddingConfig } from "@/stores/wiki-store"

const FAILURE_LOG_PATH = ".llm-wiki/embedding-failures.jsonl"

/** Pages one backfill embeds at most; the rest wait for the next tick.
 *  A page is a few chunks, so this is a few thousand embedding calls. */
export const BACKFILL_MAX_PAGES = 500

/** Failed embeds in a row after which a backfill checks the endpoint with
 *  one request, and stops if that fails too: the rest wait for the next
 *  tick (#73). If the endpoint answers, the pages themselves failed, and
 *  the run carries on. */
export const BACKFILL_STOP_AFTER_FAILURES = 5

/** Lines the failures file keeps; the oldest go first (#73). */
export const FAILURE_LOG_MAX_LINES = 1_000

export type EmbedTrigger = "backfill" | "merge" | "hub-rebuild"

export interface VectorCoverage {
  /** Content pages in the wiki. */
  pages: number
  /** Pages whose vectors match their file after this run, a page with
   *  nothing to embed included. */
  covered: number
  embedded: number
  failed: number
  /** Pages whose file is gone, whose vectors this run removed. */
  orphansRemoved: number
  /** Why the run stopped before embedding every page due, when it did. */
  stoppedEarly?: string
}

/** Failure-log appends, one at a time, so two cannot overwrite each other. */
let failureWrites: Promise<unknown> = Promise.resolve()

/**
 * Remove the vectors of pages whose file is gone, then embed, up to
 * `limit`, the content pages that have no vectors under their
 * folder-qualified id (missing, or stored under the old bare slug only),
 * then those whose file changed since they were embedded. Stops after
 * BACKFILL_STOP_AFTER_FAILURES failed embeds in a row when the endpoint
 * does not answer a check. Returns null while embeddings are off.
 */
export async function runEmbeddingBackfill(
  projectPath: string,
  cfg: EmbeddingConfig,
  limit: number = BACKFILL_MAX_PAGES,
): Promise<VectorCoverage | null> {
  if (!cfg.enabled || !cfg.model) return null
  const pp = normalizePath(projectPath)
  const pages = contentPagesInTree(pp, await listDirectory(`${pp}/wiki`))
  const stored = new Set(await listVectorPageIds(pp))
  const hashes = await loadEmbeddedHashes(pp)
  const orphansRemoved = await removeOrphanVectors(pp, pages, stored)

  let covered = 0
  let failed = 0
  const missing: Due[] = []
  const stale: Due[] = []
  for (const page of pages) {
    let content: string
    try {
      content = await readFile(page.path)
    } catch (err) {
      failed++
      await recordFailure(pp, "backfill", relativePath(pp, page.path), errorText(err))
      continue
    }
    if (!hasEmbeddableText(content, cfg)) covered++
    else if (!stored.has(page.id)) missing.push({ ...page, content })
    else if (hashes[page.id] !== (await sha256(content))) stale.push({ ...page, content })
    else covered++
  }

  let embedded = 0
  let failedInARow = 0
  let stoppedEarly: string | undefined
  const embeddedHashes: EmbeddedHashes = {}
  try {
    for (const page of [...missing, ...stale].slice(0, limit)) {
      const failure = await embedOne(pp, page, cfg, "backfill", embeddedHashes)
      if (failure === null) {
        embedded++
        failedInARow = 0
        continue
      }
      failed++
      if (++failedInARow < BACKFILL_STOP_AFTER_FAILURES) continue
      if (await endpointAnswers(cfg)) {
        failedInARow = 0
        continue
      }
      stoppedEarly = `stopped after ${failedInARow} failed embeds in a row: ${failure}`
      break
    }
  } finally {
    await recordEmbeddedHashes(pp, embeddedHashes)
  }
  const coverage: VectorCoverage = { pages: pages.length, covered: covered + embedded, embedded, failed, orphansRemoved }
  if (stoppedEarly) coverage.stoppedEarly = stoppedEarly
  return coverage
}

/** One short request, no retries: does the endpoint embed anything? */
async function endpointAnswers(cfg: EmbeddingConfig): Promise<boolean> {
  return (await fetchEmbedding("embedding endpoint check", cfg, 0)) !== null
}

/**
 * Remove the rows of each stored page id that names no content page and
 * whose file is confirmed gone. A bare-slug id whose name a page still
 * owns is kept: its page's own embed clears it once safe. An empty listing
 * removes nothing. Returns the number removed.
 */
async function removeOrphanVectors(
  pp: string,
  pages: { id: string }[],
  stored: Set<string>,
): Promise<number> {
  if (pages.length === 0) return 0
  const ids = new Set(pages.map((p) => p.id))
  const stems = new Set(pages.map((p) => (p.id.split("/").pop() ?? "").toLowerCase()))
  let removed = 0
  for (const id of stored) {
    if (ids.has(id)) continue
    if (!id.includes("/") && stems.has(id.toLowerCase())) continue
    // A page written since the listing still has its file.
    if (await fileExists(`${pp}/wiki/${id}.md`)) continue
    try {
      await removeVectorPageId(pp, id)
      removed++
    } catch (err) {
      console.warn(`[Embedding] backfill: could not remove the vectors of ${id}: ${errorText(err)}`)
    }
  }
  return removed
}

/**
 * Re-embed pages a merge or hub rebuild rewrote, by wiki-relative path
 * (`wiki/...`). Structural pages and pages with nothing to embed are
 * skipped. Returns the number that failed.
 */
export async function reembedWikiPages(
  projectPath: string,
  paths: string[],
  trigger: EmbedTrigger,
): Promise<number> {
  const cfg = useWikiStore.getState().embeddingConfig
  if (!cfg.enabled || !cfg.model) return 0
  const pp = normalizePath(projectPath)
  let failed = 0
  const embeddedHashes: EmbeddedHashes = {}
  for (const path of paths) {
    const pageId = wikiPageIdFromPath(pp, path)
    if (!pageId || !isContentPagePath(path)) continue
    try {
      const content = await readFile(`${pp}/${path}`)
      if (!hasEmbeddableText(content, cfg)) continue
      if ((await embedOne(pp, { id: pageId, path, content }, cfg, trigger, embeddedHashes)) !== null) failed++
    } catch (err) {
      failed++
      await recordFailure(pp, trigger, path, errorText(err))
    }
  }
  await recordEmbeddedHashes(pp, embeddedHashes)
  return failed
}

/** Remove the vectors of pages a merge deleted, by wiki-relative path. */
export async function removeWikiPageEmbeddings(projectPath: string, paths: string[]): Promise<void> {
  const pp = normalizePath(projectPath)
  for (const path of paths) {
    const pageId = wikiPageIdFromPath(pp, path)
    if (pageId) await removePageEmbedding(pp, pageId)
  }
}

interface Due {
  id: string
  path: string
  content: string
}

/** Embed one page, its hash into `hashes`. Returns null on success, else
 *  the reason, which it records. */
async function embedOne(
  pp: string,
  page: Due,
  cfg: EmbeddingConfig,
  trigger: EmbedTrigger,
  hashes: EmbeddedHashes,
): Promise<string | null> {
  let reason: string
  try {
    const title = extractEmbeddingTitle(page.content, page.id)
    if (await embedPage(pp, page.id, title, page.content, cfg, { hashes })) return null
    reason = getLastEmbeddingError() ?? "no chunk could be embedded"
  } catch (err) {
    reason = errorText(err)
  }
  await recordFailure(pp, trigger, relativePath(pp, page.path), reason)
  return reason
}

async function recordFailure(pp: string, trigger: EmbedTrigger, page: string, reason: string): Promise<void> {
  console.warn(`[Embedding] ${trigger}: could not embed ${page}: ${reason}`)
  const path = `${pp}/${FAILURE_LOG_PATH}`
  const line = `${JSON.stringify({ at: new Date().toISOString(), trigger, page, reason })}\n`
  const write = failureWrites.then(async () => {
    const existing = (await fileExists(path)) ? await readFile(path) : ""
    const kept = existing.split("\n").filter(Boolean).slice(-(FAILURE_LOG_MAX_LINES - 1))
    await writeFile(path, `${kept.map((l) => `${l}\n`).join("")}${line}`)
  })
  failureWrites = write.catch(() => undefined)
  await write.catch((err) => console.warn(`[Embedding] Could not record the failure: ${err}`))
}

function relativePath(pp: string, path: string): string {
  const normalized = normalizePath(path)
  return normalized.startsWith(`${pp}/`) ? normalized.slice(pp.length + 1) : normalized
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
