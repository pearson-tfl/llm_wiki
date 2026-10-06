/**
 * The check after an ingest's writes (#69): each concept or entity page the
 * ingest created is compared by meaning with the existing concept and entity
 * pages, and with the other pages the same ingest created (#75). One scoring
 * at or above the threshold is flagged – logged and raised as a duplicate
 * review item – never refused, so no content is lost.
 *
 * The score is the duplicate scan's own: the cosine of the two pages' summary
 * embeddings (title, tags and description), the text `dedup-runner.ts`
 * embeds for its prefilter.
 */
import { fileExists, readFile } from "@/commands/fs"
import { extractEntitySummary } from "@/lib/dedup"
import { summaryToEmbeddingPage } from "@/lib/dedup-runner"
import { cosineSimilarity, pageToEmbeddingText } from "@/lib/dedup_embedding"
import type { ReviewItem } from "@/stores/review-store"
import type { EmbeddingConfig } from "@/stores/wiki-store"

// Calibrated on 35 labelled pairs from the Agent Harness Wiki with
// qwen3-embedding:0.6b: recall 0.90, precision 0.75 against distinct pages
// that share words. A flag loses nothing, so recall is preferred. The table
// is in ESTATE.md (#69).
export const NEAR_DUPLICATE_THRESHOLD = 0.89
const CHECKED_FOLDERS = ["wiki/concepts/", "wiki/entities/"]
// Search hits fetched per new page: hits outside the checked folders use
// some of them.
const SEARCH_HITS = 10
// Existing pages scored against each new page, best search hits first.
const MAX_COMPARED = 5

export interface NearDuplicate {
  path: string
  existingPath: string
  /** Rounded to three places, as the log line shows it. */
  score: number
  /** `existingPath` was created by the same ingest (#75). */
  sameIngest?: true
}

export interface NewPageCheck {
  /** New concept and entity pages compared with existing pages. */
  checked: string[]
  flagged: NearDuplicate[]
  /** Why the check stopped before every new page was compared. */
  skipped?: string
}

function isCheckedPage(path: string): boolean {
  return path.endsWith(".md") && CHECKED_FOLDERS.some((folder) => path.startsWith(folder))
}

/**
 * The scan's summary text for a page; a page with no frontmatter gives its
 * file name. @internal Exported for the calibration run.
 */
export function summaryText(path: string, content: string): string {
  const summary = extractEntitySummary(path, content)
  return pageToEmbeddingText(summary ? summaryToEmbeddingPage(summary) : { id: path, title: "" })
}

/**
 * Compares each created concept or entity page with its nearest existing
 * concept and entity pages, and with the created pages before it: new pages
 * are embedded into the store only after the check. Never throws: embeddings
 * off, a failed embedding call, a vector-store error or an unreadable page
 * ends the check with the reason in `skipped`.
 */
export async function checkNewPages(
  projectPath: string,
  createdPaths: readonly string[],
  cfg: EmbeddingConfig,
): Promise<NewPageCheck> {
  const check: NewPageCheck = { checked: [], flagged: [] }
  if (!cfg.enabled || !cfg.model) return { ...check, skipped: "embeddings are off" }
  try {
    const { fetchEmbedding, getLastEmbeddingError, searchByEmbedding } = await import("@/lib/embedding")
    const embed = async (text: string) => {
      const vector = await fetchEmbedding(text, cfg)
      if (!vector) throw new Error(`embedding failed: ${getLastEmbeddingError() ?? "no vector returned"}`)
      return vector
    }

    const created: Array<{ path: string; vector: number[] }> = []
    for (const path of createdPaths.filter(isCheckedPage)) {
      const text = summaryText(path, await readFile(`${projectPath}/${path}`))
      const vector = await embed(text)

      let hits
      try {
        hits = await searchByEmbedding(projectPath, text, cfg, SEARCH_HITS, { throwOnStoreError: true })
      } catch (err) {
        throw new Error(`search failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      // searchByEmbedding answers a failed embedding fetch with no hits.
      const fetchError = hits.length === 0 ? getLastEmbeddingError() : null
      if (fetchError) throw new Error(`embedding failed: ${fetchError}`)

      // A hit stored under a bare slug, from before vector ids were
      // folder-qualified, maps to the checked folder holding that file.
      const neighbours: string[] = []
      for (const hit of hits) {
        const paths = hit.id.includes("/")
          ? [`wiki/${hit.id}.md`]
          : CHECKED_FOLDERS.map((folder) => `${folder}${hit.id}.md`)
        for (const existingPath of paths) {
          if (
            isCheckedPage(existingPath) &&
            existingPath !== path &&
            !neighbours.includes(existingPath) &&
            (await fileExists(`${projectPath}/${existingPath}`))
          ) {
            neighbours.push(existingPath)
          }
        }
      }

      let best: NearDuplicate | null = null
      for (const existingPath of neighbours.slice(0, MAX_COMPARED)) {
        const existing = await readFile(`${projectPath}/${existingPath}`)
        const score = Math.round(cosineSimilarity(vector, await embed(summaryText(existingPath, existing))) * 1000) / 1000
        if (!best || score > best.score) best = { path, existingPath, score }
      }
      check.checked.push(path)
      if (best && best.score >= NEAR_DUPLICATE_THRESHOLD) check.flagged.push(best)
      for (const twin of created) {
        const score = Math.round(cosineSimilarity(vector, twin.vector) * 1000) / 1000
        if (score >= NEAR_DUPLICATE_THRESHOLD) check.flagged.push({ path, existingPath: twin.path, score, sameIngest: true })
      }
      created.push({ path, vector })
    }
  } catch (err) {
    check.skipped = err instanceof Error ? err.message : String(err)
  }
  return check
}

/** Lines for the ingest's `wiki/log.md` entry. */
export function formatNewPageCheckLog(check: NewPageCheck): string[] {
  return [
    `- New concept and entity pages checked against existing pages: ${check.checked.length}. Near-duplicates flagged: ${check.flagged.length}.`,
    ...check.flagged.map(({ path, existingPath, score, sameIngest }) =>
      `- Near-duplicate flagged: ${path} is close to ${existingPath}${sameIngest ? ", also created by this ingest" : ""} (score ${score.toFixed(3)}).`,
    ),
    ...(check.skipped ? [`- New-page check skipped: ${check.skipped}.`] : []),
  ]
}

/** One duplicate review item per flagged pair. */
export function newPageCheckReviewItems(
  check: NewPageCheck,
  sourcePath: string,
): Omit<ReviewItem, "id" | "resolved" | "createdAt">[] {
  return check.flagged.map(({ path, existingPath, score, sameIngest }) => ({
    type: "duplicate",
    title: `Possible duplicate: ${path} and ${existingPath}`,
    description: sameIngest
      ? `Ingest created both ${path} and ${existingPath}, whose titles and summaries score ${score.toFixed(3)} against each other (threshold ${NEAR_DUPLICATE_THRESHOLD}). Both pages were written. If the two are the same subject, merge them from the duplicate scan on the Maintenance screen or by hand.`
      : `Ingest created ${path}, whose title and summary score ${score.toFixed(3)} against the existing ${existingPath} (threshold ${NEAR_DUPLICATE_THRESHOLD}). The new page was written. If the two are the same subject, merge them from the duplicate scan on the Maintenance screen or by hand.`,
    sourcePath,
    affectedPages: [path, existingPath],
    options: [
      { label: "Open new page", action: `open:${path}` },
      { label: sameIngest ? "Open other new page" : "Open existing page", action: `open:${existingPath}` },
      { label: "Skip", action: "Skip" },
    ],
  }))
}
