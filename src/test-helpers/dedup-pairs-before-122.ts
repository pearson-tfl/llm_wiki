/**
 * The duplicate prefilter's compare as it was before #122: every pair scored
 * from both sides, each score recomputing both vector lengths, each page's
 * scores sorted. Kept so tests can check the faster compare finds the same
 * pairs in the same order.
 */
import type { Page } from "@/lib/dedup_embedding"

export function pairsBefore122(
  pages: Page[],
  embeddings: Map<string, number[] | null>,
  topK: number,
  threshold: number,
): Array<readonly [string, string]> {
  const cosine = (a: number[] | null | undefined, b: number[] | null | undefined) => {
    if (!a || !b || a.length !== b.length) return 0
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom === 0 ? 0 : dot / denom
  }
  const pairSet = new Set<string>()
  const pairs: Array<readonly [string, string]> = []
  for (let i = 0; i < pages.length; i++) {
    const vi = embeddings.get(pages[i].id)
    if (!vi) continue
    const scored: Array<{ j: number; sim: number }> = []
    for (let j = 0; j < pages.length; j++) {
      if (i === j) continue
      const sim = cosine(vi, embeddings.get(pages[j].id))
      if (sim >= threshold) scored.push({ j, sim })
    }
    scored.sort((a, b) => b.sim - a.sim)
    for (let k = 0; k < Math.min(topK, scored.length); k++) {
      const a = pages[i].id
      const b = pages[scored[k].j].id
      const key = a < b ? `${a}\t${b}` : `${b}\t${a}`
      if (!pairSet.has(key)) {
        pairSet.add(key)
        pairs.push([a, b] as const)
      }
    }
  }
  return pairs
}
