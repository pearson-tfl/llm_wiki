/**
 * dedup_embedding.ts
 *
 * Vector-embedding candidate generation for duplicate-page scan.
 * Pre-filters pages by cosine similarity so the downstream LLM detector
 * only sees a small candidate set (issue #359).
 *
 * Uses real fetchEmbedding() from ./embedding (raw text → vector API).
 */
import { fetchEmbedding } from "./embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"

export interface Page {
  id: string
  title: string
  body?: string
  tags?: string[]
}

export interface CandidateOptions {
  topK?: number
  threshold?: number
  signal?: AbortSignal
  /**
   * If too many embeddings fail, callers should fall back to the old full scan
   * instead of silently missing most pages. Default: 0.8.
   */
  minSuccessRatio?: number
  /**
   * Per-page character budget for the embedding input text.
   * Real pages can be megabytes; we cap to stay within embedding context windows.
   * Default 1500 chars (matches chunker default).
   */
  textBudgetChars?: number
}

export type CandidatePair = readonly [string, string]

export class DuplicatePrefilterCancelledError extends Error {
  name = "AbortError"
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DuplicatePrefilterCancelledError("Duplicate scan cancelled")
}

/**
 * Cosine similarity between two equal-length vectors. Returns 0 if either is
 * zero, vectors differ in length, or either is null/undefined (embedding failed).
 */
export function cosineSimilarity(a: number[] | null | undefined, b: number[] | null | undefined): number {
  if (!a || !b) return 0
  return similarityOfLengths(a, vectorLength(a), b, vectorLength(b))
}

function vectorLength(v: number[]): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    sum += x * x
  }
  return Math.sqrt(sum)
}

/** Cosine similarity of two vectors whose lengths are already known. */
function similarityOfLengths(a: number[], lengthA: number, b: number[], lengthB: number): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  const denom = lengthA * lengthB
  return denom === 0 ? 0 : dot / denom
}

/**
 * How long the compare runs before handing the main thread back (#122). A
 * zero-delay timer can be held to 4 ms once timers nest, so a slice of 25 ms
 * costs at most about a seventh of the compare's time.
 */
const COMPARE_SLICE_MS = 25

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface Neighbour {
  j: number
  sim: number
}

/** Keeps `best` as the top `topK` by score, an earlier page first on a tie. */
function keepBest(best: Neighbour[], j: number, sim: number, topK: number) {
  let at = best.length
  while (at > 0 && best[at - 1].sim < sim) at--
  if (at >= topK) return
  best.splice(at, 0, { j, sim })
  if (best.length > topK) best.pop()
}

/**
 * Build the embedding input text from a page.
 * Mirrors embedPage's chunker input but keeps it short for similarity comparison.
 */
export function pageToEmbeddingText(page: Page, budget = 1500): string {
  const tagPart = (page.tags ?? []).join(" ")
  const idPart = page.id.split("/").pop()?.replace(/\.md$/i, "") ?? page.id
  const parts = [
    idPart,
    page.title,
    tagPart,
    (page.body ?? "").slice(0, budget),
  ]
  return parts.filter(Boolean).join("\n")
}

/**
 * Embed pages sequentially via fetchEmbedding.
 * Returns pageId → vector (or null if embedding failed for that page).
 */
export async function embedPages(
  pages: Page[],
  cfg: EmbeddingConfig,
  opts: { signal?: AbortSignal; textBudgetChars?: number } = {},
): Promise<Map<string, number[] | null>> {
  const out = new Map<string, number[] | null>()
  const budget = opts.textBudgetChars ?? 1500
  for (const p of pages) {
    throwIfAborted(opts.signal)
    const text = pageToEmbeddingText(p, budget)
    const vec = await fetchEmbedding(text, cfg)
    throwIfAborted(opts.signal)
    out.set(p.id, vec)
  }
  return out
}

/**
 * Generate candidate duplicate pairs: each page's top-K nearest neighbors
 * above threshold, self-excluded, symmetric deduplicated.
 *
 * Pages whose embedding failed (null) are silently skipped on the source
 * side; they may still appear as the TARGET of a pair from another page.
 */
export async function candidatePairs(
  pages: Page[],
  cfg: EmbeddingConfig,
  opts: CandidateOptions = {},
): Promise<CandidatePair[]> {
  const topK = opts.topK ?? 8
  const threshold = opts.threshold ?? 0.82
  const minSuccessRatio = opts.minSuccessRatio ?? 0.8

  if (pages.length === 0) return []

  const embeddings = await embedPages(pages, cfg, {
    signal: opts.signal,
    textBudgetChars: opts.textBudgetChars,
  })

  const embeddedCount = [...embeddings.values()].filter((v) => v && v.length > 0).length
  if (pages.length >= 2 && embeddedCount < 2) {
    throw new Error("Duplicate prefilter could not embed enough pages")
  }
  if (pages.length > 0 && embeddedCount / pages.length < minSuccessRatio) {
    throw new Error(
      `Duplicate prefilter embedded only ${embeddedCount}/${pages.length} pages`,
    )
  }

  // Each vector's length once, and each pair scored once for both its pages.
  // Neighbours reach a page in page order, so on a tie the earlier stays
  // ahead, as when each page's scores were sorted.
  const vectors = pages.map((p) => embeddings.get(p.id))
  const lengths = vectors.map((v) => (v ? vectorLength(v) : 0))
  const best: Neighbour[][] = pages.map(() => [])
  let sliceStart = performance.now()
  for (let i = 0; i < pages.length; i++) {
    const vi = vectors[i]
    for (let j = i + 1; j < pages.length; j++) {
      const vj = vectors[j]
      // A page whose embedding failed is no page's source, but it scores 0
      // as a target, so a threshold of 0 keeps it.
      if (!vi && !vj) continue
      const sim = vi && vj ? similarityOfLengths(vi, lengths[i], vj, lengths[j]) : 0
      if (!(sim >= threshold)) continue
      if (vi) keepBest(best[i], j, sim, topK)
      if (vj) keepBest(best[j], i, sim, topK)
    }
    if (performance.now() - sliceStart >= COMPARE_SLICE_MS) {
      await nextTask()
      throwIfAborted(opts.signal)
      sliceStart = performance.now()
    }
  }

  const pairSet = new Set<string>()
  const pairs: CandidatePair[] = []
  for (let i = 0; i < pages.length; i++) {
    for (const { j } of best[i]) {
      const a = pages[i].id
      const b = pages[j].id
      const key = a < b ? `${a}\t${b}` : `${b}\t${a}`
      if (!pairSet.has(key)) {
        pairSet.add(key)
        pairs.push([a, b] as const)
      }
    }
  }

  return pairs
}

/**
 * Union-find clustering of candidate pairs into groups.
 * ITERATIVE find() with path compression to avoid stack overflow on large inputs.
 */
export function clusterByPairs(
  pageIds: string[],
  pairs: CandidatePair[],
): string[][] {
  const parent = new Map<string, string>()
  for (const id of pageIds) parent.set(id, id)

  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    // path compression
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  for (const [a, b] of pairs) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const groups = new Map<string, string[]>()
  for (const id of pageIds) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(id)
  }

  return [...groups.values()].filter((g) => g.length > 1)
}
