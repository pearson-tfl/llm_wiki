/**
 * I/O wrapper that connects the pure dedup algorithm in dedup.ts
 * to the project's filesystem + LLM. The UI layer calls these
 * functions; everything below is about read/write/spawn-llm so
 * the algorithm core stays testable without mocks of all that.
 */
import { listDirectory, readFile, writeFile, deleteFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import {
  candidatePairs,
  clusterByPairs,
  DuplicatePrefilterCancelledError,
  type CandidatePair,
  type Page as DedupEmbeddingPage,
} from "@/lib/dedup_embedding"
import { reembedWikiPages, removeWikiPageEmbeddings } from "@/lib/embedding-freshness"
import { loadEmbeddingConfig } from "@/lib/project-store"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"

/**
 * Detection emits a bounded JSON list of duplicate groups — a few tens
 * of tokens per group — so a modest cap covers even a very duplicate-
 * heavy wiki. The cap's real job is a safety net: without it, a model
 * that ignores the reasoning-off lever (an unrecognized reasoning model
 * behind a custom endpoint, e.g. a vLLM Nemotron build) could stream
 * chain-of-thought unbounded until the 30-min backstop fires — which
 * surfaces to the user as a bare "request cancelled". Capping turns a
 * 30-min hang into a fast cut-off reply instead, which the scan reports as
 * a failed batch (#108).
 */
const DEDUP_DETECTION_MAX_TOKENS = 8_192
// Conservative defaults: keep enough neighbors for recall while cutting the
// LLM detector prompt into small candidate batches. The threshold is deliberately
// below "near duplicate" territory because this tool must catch cross-language
// aliases, where cosine scores can be weaker on non-multilingual embedders.
const DEDUP_PREFILTER_TOP_K = 8
const DEDUP_PREFILTER_THRESHOLD = 0.68
const DEDUP_DETECTOR_BATCH_SUMMARIES = 80
const DEDUP_FALLBACK_BATCH_OVERLAP = 8
const DEDUP_EMPTY_PREFILTER_FULL_SCAN_LIMIT = 250
// A hung endpoint waits out the client's 30-min timeout on every call, and a
// rate-limited one is fired at again at once, so the scan stops calling after
// this many detector calls in a row fail (#124). Both judges stop at the
// same count (#139, #145).
export const DEDUP_CONSECUTIVE_CALL_FAILURES_TO_STOP = 2

/**
 * Merge rewrites a COMPLETE page that gets written to disk, so it needs
 * a generous cap that won't truncate the canonical content. 16K tokens
 * is ~64KB of text — far beyond any realistic merged entity/concept
 * page — while still bounding a runaway short of the 30-min backstop.
 * Kept local (not the ingest generation ladder) so this module doesn't
 * drag in the heavy ingest dependency graph.
 */
const DEDUP_MERGE_MAX_TOKENS = 16_384
/** The judges answer with a short JSON list of page groups (#135, #145). */
export const DEDUP_JUDGE_MAX_TOKENS = 2_048
import {
  allPairs,
  ambiguousSlugRefusal,
  detectDuplicateGroups,
  DetectorCallFailedError,
  DetectorReplyUnreadableError,
  distinctPairs,
  extractEntitySummary,
  judgeSharedSlugPages,
  mergeDuplicateGroup,
  mergedAwayNames,
  MergeReplyRejectedError,
  pagesNamed,
  rewriteIndexMd,
  sameSlugGroups,
  sharedSlugCandidates,
  toWikiRelative,
  type DedupLlmCall,
  type DuplicateGroup,
  type EntitySummary,
  type MergeResult,
} from "./dedup"
import { loadNotDuplicates, recordNotDuplicates } from "./dedup-storage"
import { resolveIngestReasoning } from "@/lib/reasoning-capabilities"
import { getTaskLlmConfig } from "@/lib/llm-task-routing"

/**
 * Wrap streamChat into the (system, user, signal) → string shape
 * the dedup module expects. Same pattern page-merge uses — keeps
 * the algorithm modules free of any LlmConfig knowledge.
 *
 * `maxTokens` is required, not defaulted: detection and merge have
 * very different output-size needs (a tiny JSON list vs. a complete
 * rewritten page), and silently sharing one cap risks truncating a
 * merged page on disk. Forcing each caller to state its budget makes
 * that choice explicit.
 *
 * `completeReplyOnly` is for the merge, whose reply is written to disk
 * (#29): a reply cut off at the cap is rejected, and a reply whose
 * signal fired throws, since the client ends a cancelled request as
 * done with whatever text had arrived. Detection refuses a cut-off reply
 * too, as unreadable (#108): its groups may be missing. A detection call
 * that fails throws DetectorCallFailedError, so the scan reports its batch
 * as failed (#118); a cancelled one throws the client's error.
 */
export function buildDedupLlmCall(
  llmConfig: LlmConfig,
  maxTokens: number,
  options: { completeReplyOnly?: boolean } = {},
): DedupLlmCall {
  return async (systemPrompt, userMessage, signal) => {
    let result = ""
    let cutOff = false
    // Asserted, not annotated: the callbacks assign it, which TypeScript
    // does not see, so an annotated null would narrow it to never.
    let streamError = null as Error | null
    await new Promise<void>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (t) => {
            result += t
          },
          onDone: (completion) => {
            cutOff = completion?.truncated === true
            resolve()
          },
          onError: (err) => {
            streamError = err
            resolve()
          },
        },
        signal,
        // Dedup detection + merge want compact JSON. Keep the output capped;
        // reasoning defaults off but remains configurable for models that
        // require it.
        { temperature: 0.1, reasoning: resolveIngestReasoning(llmConfig), max_tokens: maxTokens },
      ).catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (options.completeReplyOnly && signal?.aborted) {
      throw new Error("Duplicate merge cancelled before the model's reply finished")
    }
    if (streamError) {
      // A detection call that fails is its batch's failure, not the scan's
      // (#118); a cancelled one still cancels the scan.
      if (options.completeReplyOnly || signal?.aborted) throw streamError
      throw new DetectorCallFailedError(streamError.message)
    }
    if (cutOff) {
      // Not the cap asked for: the CLI routes ignore it and stop at their own.
      const reason = "the model's reply was cut off at its output limit"
      throw options.completeReplyOnly
        ? new MergeReplyRejectedError(reason)
        : new DetectorReplyUnreadableError(reason)
    }
    return result
  }
}

/** Walk a FileNode tree, yielding every .md file under a given prefix. */
function* walkMd(nodes: FileNode[], prefix: string): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) yield* walkMd(node.children, prefix)
      continue
    }
    if (node.name.endsWith(".md") && node.path.includes(`${prefix}/`)) {
      yield node
    }
  }
}

/**
 * Walk wiki/entities/ and wiki/concepts/, build summaries.
 * Pages that fail to parse (no frontmatter, etc.) are skipped
 * silently — they can't participate in dedup anyway.
 */
export async function loadAllEntitySummaries(
  projectPath: string,
): Promise<EntitySummary[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const out: EntitySummary[] = []
  for (const prefix of ["wiki/entities", "wiki/concepts"]) {
    for (const node of walkMd(tree, prefix)) {
      try {
        const content = await readFile(node.path)
        const rel = toWikiRelative(pp, node.path)
        const summary = extractEntitySummary(rel, content)
        if (summary) out.push(summary)
      } catch {
        // best-effort — skip unreadable pages
      }
    }
  }
  return out
}

/** Read every .md under wiki/ as { path, content }. The path is
 *  the wiki-relative form callers downstream use. */
export async function loadAllWikiPages(
  projectPath: string,
): Promise<{ path: string; content: string }[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const out: { path: string; content: string }[] = []
  for (const node of walkMd(tree, "wiki")) {
    try {
      const content = await readFile(node.path)
      out.push({ path: toWikiRelative(pp, node.path), content })
    } catch {
      // ignore
    }
  }
  return out
}

/** A detector batch that failed: its reply could not be read (#108) or its
 *  call failed (#118). Its pages went unchecked. */
export interface FailedDetectorBatch {
  pages: number
  reason: string
}

/** Why the model checked none of a large wiki's pages (#112). */
export type ScanNotDoneReason = "embedding-coverage-low" | "no-candidate-pairs"

/** A large wiki the model did not check: no group it would find is reported. */
export interface ScanNotDone {
  reason: ScanNotDoneReason
  pages: number
}

export interface DuplicateScanResult {
  groups: DuplicateGroup[]
  failedBatches: FailedDetectorBatch[]
  /** Present when the model's check was skipped; absent when it ran. */
  notDone?: ScanNotDone
}

const noGroups = (): DuplicateScanResult => ({ groups: [], failedBatches: [] })

const notDoneResult = (reason: ScanNotDoneReason, pages: number): DuplicateScanResult =>
  ({ ...noGroups(), notDone: { reason, pages } })

/**
 * Stage 1 + 2 from the user's perspective: scan the project for
 * duplicate-candidate groups. Reads notDuplicates whitelist from
 * disk so previously-confirmed false-positives don't reappear.
 */
export async function runDuplicateDetection(
  projectPath: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<DuplicateScanResult> {
  const summaries = await loadAllEntitySummaries(projectPath)
  if (summaries.length < 2) return noGroups()
  const notDup = await loadNotDuplicates(projectPath)
  const sameSlug = sameSlugGroups(summaries, notDup)
  const detected = await detectWithModel(summaries, notDup, llmConfig, options)
  const settled = await settleSharedSlugGroups(projectPath, summaries, [...sameSlug, ...detected.groups], notDup, options)
  return {
    ...detected,
    groups: uniqueDuplicateGroups(settled.groups),
    failedBatches: [...detected.failedBatches, ...settled.failedBatches],
  }
}

/**
 * Settle every group whose pages include two that share a slug, so none is
 * left for a decision by hand (#135). The judge, on the chat route, is given
 * the pages by path with their content: pages it finds one topic come back
 * as a high group of page ids, which the scheduled run merges; each other
 * pair is recorded as not duplicates, so no later scan asks again. A group
 * all of whose pairs are recorded is dropped with no call. A judge call that
 * fails, or a reply it cannot read, is a failed batch, and the group stays.
 * After DEDUP_CONSECUTIVE_CALL_FAILURES_TO_STOP judge calls in a row fail,
 * each group left stays and is reported as failed without a call (#139).
 */
async function settleSharedSlugGroups(
  projectPath: string,
  summaries: EntitySummary[],
  groups: DuplicateGroup[],
  notDup: string[][],
  options: { signal?: AbortSignal },
): Promise<Pick<DuplicateScanResult, "groups" | "failedBatches">> {
  const pp = normalizePath(projectPath)
  const judge = buildDedupLlmCall(getTaskLlmConfig("chat"), DEDUP_JUDGE_MAX_TOKENS)
  // Verdicts recorded during this scan count for the groups after them.
  const recorded = new Set(notDup.map(normalizeSlugGroupKey))
  const out: DuplicateGroup[] = []
  const failedBatches: FailedDetectorBatch[] = []
  let callFailuresInARow = 0
  for (const group of groups) {
    const candidates = sharedSlugCandidates(summaries, group)
    if (!candidates) {
      out.push(group)
      continue
    }
    const unrecorded = (pairs: string[][]) => pairs.filter((pair) => !recorded.has(normalizeSlugGroupKey(pair)))
    if (unrecorded(allPairs(candidates)).length === 0) continue
    if (callFailuresInARow === DEDUP_CONSECUTIVE_CALL_FAILURES_TO_STOP) {
      const reason = `Not checked: the shared-slug judge stopped after ${callFailuresInARow} calls in a row failed`
      console.warn(`[dedup] ${reason}: ${candidates.join(", ")}`)
      failedBatches.push({ pages: candidates.length, reason })
      out.push(group)
      continue
    }
    let topics
    try {
      const pages = await Promise.all(candidates.map(async (pageId) =>
        ({ pageId, content: await readFile(`${pp}/wiki/${pageId}.md`) })))
      topics = await judgeSharedSlugPages(pages, judge, options.signal)
      callFailuresInARow = 0
    } catch (err) {
      if (options.signal?.aborted) throw err
      if (err instanceof DetectorCallFailedError) {
        callFailuresInARow += 1
      } else if (err instanceof DetectorReplyUnreadableError) {
        callFailuresInARow = 0
      }
      failedBatches.push({ pages: candidates.length, reason: `Shared-slug judge: ${errorMessage(err)}` })
      out.push(group)
      continue
    }
    for (const topic of topics) {
      const reason = topic.reason.trim() ? `Judged one topic: ${topic.reason}` : "Judged one topic"
      out.push({ slugs: topic.pages, reason, confidence: "high", judged: true })
    }
    const distinct = unrecorded(distinctPairs(candidates, topics))
    if (distinct.length === 0) continue
    try {
      await recordNotDuplicates(pp, distinct)
      for (const pair of distinct) recorded.add(normalizeSlugGroupKey(pair))
    } catch (err) {
      failedBatches.push({
        pages: candidates.length,
        reason: `Shared-slug judge: the pages judged distinct could not be recorded: ${errorMessage(err)}`,
      })
    }
  }
  return { groups: out, failedBatches }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A scan the Maintenance screen runs, with its Cancel. */
export interface DuplicateScan {
  /** The scan's result, or null once it is cancelled. */
  done: Promise<DuplicateScanResult | null>
  cancel: () => void
}

/** Starts a scan that `cancel` stops, the prefilter's compare included (#122). */
export function startDuplicateScan(projectPath: string, llmConfig: LlmConfig): DuplicateScan {
  const controller = new AbortController()
  const done = runDuplicateDetection(projectPath, llmConfig, { signal: controller.signal })
    .catch((err: unknown) => {
      if (controller.signal.aborted) return null
      throw err
    })
  return { done, cancel: () => controller.abort() }
}

/** The model's part of the scan: the embedding prefilter, then the detector. */
async function detectWithModel(
  summaries: EntitySummary[],
  notDup: string[][],
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal },
): Promise<DuplicateScanResult> {
  const llm = buildDedupLlmCall(llmConfig, DEDUP_DETECTION_MAX_TOKENS)
  const embeddingConfig = await loadEmbeddingConfig()

  const embeddingEndpoint =
    typeof embeddingConfig?.endpoint === "string" ? embeddingConfig.endpoint.trim() : ""
  if (embeddingConfig?.enabled && embeddingEndpoint) {
    // Only the prefilter's own failure falls back to the full scan: a
    // detector call that fails is its batch's failure (#118).
    let pairs: CandidatePair[] | undefined
    try {
      pairs = await candidatePairs(summaries.map(summaryToEmbeddingPage), embeddingConfig, {
        topK: DEDUP_PREFILTER_TOP_K,
        threshold: DEDUP_PREFILTER_THRESHOLD,
        signal: options.signal,
      })
    } catch (err) {
      if (isAbortError(err) || options.signal?.aborted) throw err
      if (summaries.length > DEDUP_EMPTY_PREFILTER_FULL_SCAN_LIMIT && isEmbeddingCoverageError(err)) {
        console.warn("[dedup] embedding prefilter coverage too low; skipping full fallback for large wiki:", err)
        return notDoneResult("embedding-coverage-low", summaries.length)
      }
      console.warn("[dedup] embedding prefilter failed; falling back to full LLM scan:", err)
    }
    if (pairs) {
      return detectAmongCandidatePairs(summaries, pairs, llm, {
        signal: options.signal,
        notDuplicates: notDup,
      })
    }
  }

  return detectDuplicateGroupsInBoundedBatches(summaries, llm, {
    signal: options.signal,
    notDuplicates: notDup,
  })
}

async function detectDuplicateGroupsInBoundedBatches(
  summaries: EntitySummary[],
  llm: DedupLlmCall,
  options: { signal?: AbortSignal; notDuplicates?: string[][] },
): Promise<DuplicateScanResult> {
  if (summaries.length <= DEDUP_DETECTOR_BATCH_SUMMARIES) {
    return detectInBatches([summaries], llm, options)
  }

  // Keep likely aliases adjacent while bounding every LLM request. A small
  // overlap prevents a duplicate pair at a batch boundary from being split.
  const ordered = [...summaries].sort((left, right) =>
    `${left.title}\u0000${left.slug}`.localeCompare(`${right.title}\u0000${right.slug}`),
  )
  const stride = DEDUP_DETECTOR_BATCH_SUMMARIES - DEDUP_FALLBACK_BATCH_OVERLAP
  const batches: EntitySummary[][] = []
  for (let start = 0; start < ordered.length; start += stride) {
    const batch = ordered.slice(start, start + DEDUP_DETECTOR_BATCH_SUMMARIES)
    if (batch.length < 2) break
    batches.push(batch)
  }
  return detectInBatches(batches, llm, options)
}

/** One detector call per batch. A reply that cannot be read (#108), or a
 *  call that fails (#118), is reported as a failed batch, not counted as no
 *  duplicates, and the other batches' groups stand. After
 *  DEDUP_CONSECUTIVE_CALL_FAILURES_TO_STOP calls in a row fail, the batches
 *  left are reported as failed without a call (#124). */
async function detectInBatches(
  batches: EntitySummary[][],
  llm: DedupLlmCall,
  options: { signal?: AbortSignal; notDuplicates?: string[][] },
): Promise<DuplicateScanResult> {
  const groups: DuplicateGroup[] = []
  const failedBatches: FailedDetectorBatch[] = []
  let callFailuresInARow = 0
  for (const [index, batch] of batches.entries()) {
    if (options.signal?.aborted) throw new Error("Duplicate scan cancelled")
    if (callFailuresInARow === DEDUP_CONSECUTIVE_CALL_FAILURES_TO_STOP) {
      const reason = `Not checked: the scan stopped after ${callFailuresInARow} detector calls in a row failed`
      console.warn(`[dedup] ${reason}; ${batches.length - index} batches left unchecked`)
      for (const left of batches.slice(index)) failedBatches.push({ pages: left.length, reason })
      break
    }
    try {
      groups.push(...await detectDuplicateGroups(batch, llm, options))
      callFailuresInARow = 0
    } catch (err) {
      if (err instanceof DetectorCallFailedError) {
        console.warn("[dedup] detector call failed; its batch is reported as failed:", err)
        callFailuresInARow += 1
      } else if (err instanceof DetectorReplyUnreadableError) {
        callFailuresInARow = 0
      } else {
        throw err
      }
      failedBatches.push({ pages: batch.length, reason: err.message })
    }
  }
  return { groups: uniqueDuplicateGroups(groups), failedBatches }
}

async function detectAmongCandidatePairs(
  summaries: EntitySummary[],
  pairs: CandidatePair[],
  llm: DedupLlmCall,
  options: { signal?: AbortSignal; notDuplicates?: string[][] },
): Promise<DuplicateScanResult> {
  if (pairs.length === 0) {
    // Preserve recall for small/medium wikis: a weak or non-multilingual
    // embedder can miss exactly the cross-language aliases the LLM detector
    // is meant to find. For large wikis, the old full scan is what caused
    // #359 hangs, so no candidates means no detector call, and the scan
    // says so rather than reporting the wiki clean (#112).
    return summaries.length <= DEDUP_EMPTY_PREFILTER_FULL_SCAN_LIMIT
      ? detectDuplicateGroupsInBoundedBatches(summaries, llm, options)
      : notDoneResult("no-candidate-pairs", summaries.length)
  }

  const summaryByPath = new Map(summaries.map((s) => [s.path, s]))
  const filteredPairs = filterWhitelistedPairs(pairs, summaryByPath, options.notDuplicates ?? [])
  if (filteredPairs.length === 0) return noGroups()

  const pageIds = summaries.map((s) => s.path)
  const clusters = clusterByPairs(pageIds, filteredPairs)
  if (clusters.length === 0) return noGroups()

  return detectInBatches(batchCandidateClusters(clusters, summaryByPath, filteredPairs), llm, options)
}

export function summaryToEmbeddingPage(summary: EntitySummary): DedupEmbeddingPage {
  return {
    id: summary.path,
    title: summary.title,
    body: summary.description ?? "",
    tags: summary.tags,
  }
}

function batchCandidateClusters(
  clusters: string[][],
  summaryByPath: Map<string, EntitySummary>,
  pairs: CandidatePair[],
): EntitySummary[][] {
  const batches: EntitySummary[][] = []
  let current: EntitySummary[] = []
  const toSummaries = (pageIds: string[]) => pageIds
    .map((pageId) => summaryByPath.get(pageId))
    .filter((summary): summary is EntitySummary => !!summary)

  const neighbours = new Map<string, string[]>()
  for (const [a, b] of pairs) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const list = neighbours.get(from)
      if (list) list.push(to)
      else neighbours.set(from, [to])
    }
  }

  for (const cluster of clusters) {
    if (cluster.length > DEDUP_DETECTOR_BATCH_SUMMARIES) {
      for (const part of splitOversizedCluster(cluster, neighbours)) batches.push(toSummaries(part))
      continue
    }
    const summaries = toSummaries(cluster)
    if (summaries.length < 2) continue

    if (
      current.length > 0
      && current.length + summaries.length > DEDUP_DETECTOR_BATCH_SUMMARIES
    ) {
      batches.push(current)
      current = []
    }

    current.push(...summaries)

    if (current.length >= DEDUP_DETECTOR_BATCH_SUMMARIES) {
      batches.push(current)
      current = []
    }
  }

  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Split a cluster too big for one detector call so every candidate pair in
 * it shares at least one batch (#108). Pairs chain into clusters, so one
 * cluster can hold most of the wiki. Each page's pairs are walked in turn:
 * both ends of a pair go into the current batch, which is closed when the
 * next pair would take it past the cap, and a pair a closed batch already
 * holds is skipped.
 */
function splitOversizedCluster(cluster: string[], neighbours: Map<string, string[]>): string[][] {
  const batches: string[][] = []
  const covered = new Set<string>()
  const pairKey = (a: string, b: string) => (a < b ? `${a}\t${b}` : `${b}\t${a}`)
  let current = new Set<string>()
  const close = () => {
    for (const page of current) {
      for (const other of neighbours.get(page) ?? []) {
        if (current.has(other)) covered.add(pairKey(page, other))
      }
    }
    batches.push([...current])
    current = new Set()
  }

  for (const page of cluster) {
    for (const other of neighbours.get(page) ?? []) {
      if (covered.has(pairKey(page, other))) continue
      const adding = Number(!current.has(page)) + Number(!current.has(other))
      if (current.size + adding > DEDUP_DETECTOR_BATCH_SUMMARIES) close()
      current.add(page)
      current.add(other)
    }
  }
  if (current.size > 0) close()
  return batches
}

function uniqueDuplicateGroups(groups: DuplicateGroup[]): DuplicateGroup[] {
  const seen = new Set<string>()
  const out: DuplicateGroup[] = []
  for (const group of groups) {
    const key = group.slugs.map((slug) => slug.toLowerCase()).sort().join("\t")
    if (seen.has(key)) continue
    seen.add(key)
    out.push(group)
  }
  return out
}

function filterWhitelistedPairs(
  pairs: CandidatePair[],
  summaryByPath: Map<string, EntitySummary>,
  notDuplicates: string[][],
): CandidatePair[] {
  if (notDuplicates.length === 0) return pairs
  const notDupSet = new Set(notDuplicates.map(normalizeSlugGroupKey))
  return pairs.filter(([a, b]) => {
    const left = summaryByPath.get(a)?.slug
    const right = summaryByPath.get(b)?.slug
    if (!left || !right) return true
    return !notDupSet.has(normalizeSlugGroupKey([left, right]))
  })
}

function normalizeSlugGroupKey(slugs: readonly string[]): string {
  return slugs.map((slug) => slug.toLowerCase()).sort().join("\t")
}

function isAbortError(err: unknown): boolean {
  return err instanceof DuplicatePrefilterCancelledError
    || (err instanceof Error && err.name === "AbortError")
}

function isEmbeddingCoverageError(err: unknown): boolean {
  return err instanceof Error
    && /could not embed enough pages|embedded only \d+\/\d+ pages/i.test(err.message)
}

/**
 * Stage 3 + persistence: execute one user-confirmed merge.
 *
 * Steps:
 *   1. Load each group page's full content + every other wiki page
 *   2. Run mergeDuplicateGroup (LLM body merge + frontmatter
 *      union + cross-reference rewrites)
 *   3. Snapshot every touched file to .llm-wiki/page-history/
 *      dedup-<timestamp>/
 *   4. Write canonical content
 *   5. Apply cross-reference rewrites
 *   6. Delete merged-away files
 *   7. Apply index.md rewrite (separate pass — index isn't in
 *      otherWikiPages because removing references is a different
 *      operation than slug-rewriting them)
 *   8. Remove the merged-away pages' vectors (#67)
 *
 * The caller re-embeds the pages it wrote with `reembedMergedPages`, once
 * it has released the project write lock (#73).
 */
export async function executeMerge(
  projectPath: string,
  group: DuplicateGroup,
  canonicalSlug: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<MergeResult> {
  const pp = normalizePath(projectPath)

  // 1. Resolve each group page to its on-disk path + content. A page named
  //    twice, by one name or by its slug and its page id, is one page (#109).
  const allPages = await loadAllWikiPages(pp)
  const groupPages: { slug: string; path: string; content: string }[] = []
  for (const slug of group.slugs) {
    const page = findGroupPage(allPages, slug)
    if (!groupPages.some((p) => p.path === page.path)) groupPages.push({ slug, ...page })
  }

  const groupPaths = new Set(groupPages.map((p) => p.path))
  const otherPages = allPages.filter((p) => !groupPaths.has(p.path))

  // Merge rewrites a COMPLETE page that gets written to disk, so it gets
  // the generous merge budget — never the small detection cap, which
  // would truncate the canonical content.
  const llm = buildDedupLlmCall(llmConfig, DEDUP_MERGE_MAX_TOKENS, { completeReplyOnly: true })
  const result = await mergeDuplicateGroup(
    {
      group: groupPages,
      canonicalSlug,
      otherWikiPages: otherPages,
    },
    llm,
    { signal: options.signal },
  )

  // 2. Snapshot backup before any writes. If a write fails partway
  //    through, the user has the pre-merge state intact in
  //    .llm-wiki/page-history/.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = `${pp}/.llm-wiki/page-history/dedup-${stamp}`
  for (const b of result.backup) {
    const sanitized = b.path.replace(/[/\\]/g, "_")
    await writeFile(`${backupDir}/${sanitized}`, b.content)
  }

  // 3. Write canonical
  await writeFile(`${pp}/${result.canonicalPath}`, result.canonicalContent)

  // 4. Apply rewrites
  for (const r of result.rewrites) {
    await writeFile(`${pp}/${r.path}`, r.newContent)
  }

  // 5. Delete merged-away pages, their vectors first: a bare-slug row is
  //    only removed while the page that owns the name is still on disk.
  await removeWikiPageEmbeddings(pp, result.pagesToDelete)
  for (const dead of result.pagesToDelete) {
    try {
      await deleteFile(`${pp}/${dead}`)
    } catch (err) {
      // Surface as a warning — backup is still safe.
      console.warn(`[dedup] failed to delete ${dead}: ${err}`)
    }
  }

  // 6. Rewrite index.md to drop merged-away entries.
  const indexPath = `${pp}/wiki/index.md`
  const indexEntry = allPages.find((p) => p.path === "wiki/index.md")
  if (indexEntry) {
    const removed = new Set(mergedAwayNames(groupPages, canonicalSlug, otherPages))
    const rewritten = rewriteIndexMd(indexEntry.content, removed)
    if (rewritten !== indexEntry.content) {
      await writeFile(indexPath, rewritten)
    }
  }

  return result
}

/**
 * The page a group names, found by `pagesNamed`. A slug that names more
 * than one page is refused, not resolved to one of them (#109).
 */
function findGroupPage(
  allPages: { path: string; content: string }[],
  slug: string,
): { path: string; content: string } {
  const found = pagesNamed(allPages, slug)
  if (found.length === 0) {
    throw new Error(
      `Slug "${slug}" not found on disk — was the page deleted between detection and merge?`,
    )
  }
  const refusal = ambiguousSlugRefusal(allPages, slug)
  if (refusal) throw new Error(refusal)
  return found[0]
}

/**
 * Re-embed the canonical page and every page a merge rewrote (#67). It
 * waits on the embedding endpoint, so it runs outside the project write
 * lock (#73). A failed embed is recorded, not thrown, and the page keeps
 * its old hash, so the next backfill tries it again.
 */
export async function reembedMergedPages(projectPath: string, result: MergeResult): Promise<void> {
  await reembedWikiPages(
    normalizePath(projectPath),
    [result.canonicalPath, ...result.rewrites.map((r) => r.path)],
    "merge",
  )
}
