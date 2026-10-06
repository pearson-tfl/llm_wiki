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
  extractEmbeddingTitle,
  getLastEmbeddingError,
  hasEmbeddableText,
  isContentPagePath,
  listVectorPageIds,
  loadEmbeddedHashes,
  removePageEmbedding,
  wikiPageIdFromPath,
} from "@/lib/embedding"
import { sha256 } from "@/lib/ingest-cache"
import { normalizePath } from "@/lib/path-utils"
import { useWikiStore, type EmbeddingConfig } from "@/stores/wiki-store"

const FAILURE_LOG_PATH = ".llm-wiki/embedding-failures.jsonl"

/** Pages one backfill embeds at most; the rest wait for the next tick.
 *  A page is a few chunks, so this is a few thousand embedding calls. */
export const BACKFILL_MAX_PAGES = 500

export type EmbedTrigger = "backfill" | "merge" | "hub-rebuild"

export interface VectorCoverage {
  /** Content pages in the wiki. */
  pages: number
  /** Pages whose vectors match their file after this run, a page with
   *  nothing to embed included. */
  covered: number
  embedded: number
  failed: number
}

/** Failure-log appends, one at a time, so two cannot overwrite each other. */
let failureWrites: Promise<unknown> = Promise.resolve()

/**
 * Embed, up to `limit`, the content pages that have no vectors under their
 * folder-qualified id (missing, or stored under the old bare slug only),
 * then those whose file changed since they were embedded. Returns null
 * while embeddings are off.
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
  for (const page of [...missing, ...stale].slice(0, limit)) {
    if (await embedOne(pp, page, cfg, "backfill")) embedded++
    else failed++
  }
  return { pages: pages.length, covered: covered + embedded, embedded, failed }
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
  for (const path of paths) {
    const pageId = wikiPageIdFromPath(pp, path)
    if (!pageId || !isContentPagePath(path)) continue
    try {
      const content = await readFile(`${pp}/${path}`)
      if (!hasEmbeddableText(content, cfg)) continue
      if (!(await embedOne(pp, { id: pageId, path, content }, cfg, trigger))) failed++
    } catch (err) {
      failed++
      await recordFailure(pp, trigger, path, errorText(err))
    }
  }
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

async function embedOne(pp: string, page: Due, cfg: EmbeddingConfig, trigger: EmbedTrigger): Promise<boolean> {
  let reason: string
  try {
    const title = extractEmbeddingTitle(page.content, page.id)
    if (await embedPage(pp, page.id, title, page.content, cfg)) return true
    reason = getLastEmbeddingError() ?? "no chunk could be embedded"
  } catch (err) {
    reason = errorText(err)
  }
  await recordFailure(pp, trigger, relativePath(pp, page.path), reason)
  return false
}

async function recordFailure(pp: string, trigger: EmbedTrigger, page: string, reason: string): Promise<void> {
  console.warn(`[Embedding] ${trigger}: could not embed ${page}: ${reason}`)
  const path = `${pp}/${FAILURE_LOG_PATH}`
  const line = `${JSON.stringify({ at: new Date().toISOString(), trigger, page, reason })}\n`
  const write = failureWrites.then(async () => {
    const existing = (await fileExists(path)) ? await readFile(path) : ""
    await writeFile(path, `${existing}${line}`)
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
