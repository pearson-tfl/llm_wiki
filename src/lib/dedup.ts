/**
 * Duplicate-entity / -concept detection and merge for wiki maintenance.
 *
 * Problem: across re-ingests, the LLM names the same underlying
 * topic differently — `paos` vs `聚磷菌`, `dpao` vs `dpaos` (plural)
 * vs `反硝化除磷菌`, `vfa` vs `volatile-fatty-acids`. Each becomes a
 * separate page even though they're the same entity. The page-merge
 * layer only catches *exact* slug collisions; this module catches
 * the soft-collision case via an LLM-driven self-check.
 *
 * Three stages and a judge between the second and third, each
 * independently testable:
 *
 *   1. extractEntitySummaries: walk wiki/entities and wiki/concepts,
 *      pull (slug, title, description, tags) per page. Pure-data;
 *      no LLM. sameSlugGroups groups the pages that share a slug
 *      from their paths alone.
 *   2. detectDuplicateGroups: hand the summary list to an LLM, ask
 *      it to identify groups of slugs likely to refer to the same
 *      thing. Returns parsed JSON groups with reason + confidence.
 *      The LLM call is injected so unit tests don't hit a model.
 *  2b. judgeSharedSlugPages: hand the pages a group names that
 *      share a slug, by path with their content, to an LLM, ask
 *      which are one topic. The rest are distinct (distinctPairs),
 *      so the caller records them and never merges them (#135).
 *      The scheduled run asks it of a high group's pages too, before
 *      merging the group with no click (#145).
 *   3. mergeDuplicateGroup: given a confirmed group + chosen
 *      canonical slug, merge bodies (LLM call, its reply checked as
 *      the page merge checks one), union frontmatter
 *      array fields (deterministic), rewrite every wikilink /
 *      `related:` reference / index.md entry across the wiki, and
 *      package up a result the caller writes to disk + backs up.
 *
 * The caller (UI) is responsible for filesystem reads/writes and
 * for showing the user the candidate groups. This module only
 * transforms data.
 */

import { parseFrontmatter } from "./frontmatter"
import { normalizePath } from "./path-utils"
import {
  parseFrontmatterArray,
  mergeArrayFieldsIntoContent,
  writeFrontmatterArray,
} from "./sources-merge"
import { BODY_SHRINK_THRESHOLD } from "./page-merge"

// ──────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────

export interface EntitySummary {
  /** kebab-case slug (basename without `.md`). */
  slug: string
  /** Path relative to project root, e.g. `wiki/entities/foo.md`. */
  path: string
  /** entity | concept | source | ... — frontmatter `type` field. */
  type: string
  title: string
  /** Optional one-line description from frontmatter `description`,
   *  or the first non-empty body paragraph as a fallback. Truncated
   *  to ~200 chars to keep the detector prompt small. */
  description?: string
  tags: string[]
}

export interface DuplicateGroup {
  /** Two or more pages from the input list, each named by its slug, or,
   *  where pages share a slug, by its page id: its path under `wiki/`
   *  without `.md`, e.g. `concepts/agent-skills` (#109). */
  slugs: string[]
  /** Why the model believes these are duplicates. Short prose. */
  reason: string
  confidence: "high" | "medium" | "low"
  /** Set on a group the shared-slug judge found one topic (#135), so the
   *  scheduled run does not judge it again before merging it (#145). */
  judged?: boolean
}

export interface MergeRequest {
  /** Pages in the duplicate group, with their full content loaded. */
  group: { slug: string; path: string; content: string }[]
  /** Slug to keep. Must be one of group[].slug. The other pages
   *  are deleted; their wikilinks/related entries get rewritten
   *  to point here. */
  canonicalSlug: string
  /** Every other .md under the project's wiki/ tree. Used to
   *  rewrite cross-references when the merge replaces multiple
   *  pages with one. */
  otherWikiPages: { path: string; content: string }[]
}

export interface MergeResult {
  /** Final content of the canonical page (frontmatter + body),
   *  after LLM body merge + deterministic frontmatter unification. */
  canonicalContent: string
  /** Path of the canonical page on disk (one of the group's). */
  canonicalPath: string
  /** Cross-reference rewrites in other wiki pages. Caller writes
   *  each (path → newContent) back to disk. */
  rewrites: { path: string; newContent: string }[]
  /** Paths to delete after canonical + rewrites are written.
   *  Excludes the canonical path. */
  pagesToDelete: string[]
  /** Snapshot of every file the merge touches BEFORE the merge
   *  was computed. Caller persists this to .llm-wiki/page-history/
   *  before writing changes so a bad merge can be rolled back. */
  backup: { path: string; content: string }[]
}

/**
 * The model's merge reply failed the check run before anything is
 * written: every page stays as it was and nothing is deleted.
 */
export class MergeReplyRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`Merge reply rejected: ${reason}`)
    this.name = "MergeReplyRejectedError"
  }
}

/**
 * The detector's reply could not be read as its JSON, or was cut off: the
 * pages in that batch went unchecked, which is not "no duplicates" (#108).
 */
export class DetectorReplyUnreadableError extends Error {
  constructor(reason: string) {
    super(`Duplicate detector reply could not be read: ${reason}`)
    this.name = "DetectorReplyUnreadableError"
  }
}

/**
 * The detector's model call itself failed – a network error, an HTTP error
 * such as a 429 or a 5xx – so its batch went unchecked (#118).
 */
export class DetectorCallFailedError extends Error {
  constructor(reason: string) {
    super(`Duplicate detector call failed: ${reason}`)
    this.name = "DetectorCallFailedError"
  }
}

/**
 * Generic two-prompt LLM call. Both detector and merger use it.
 * Production wraps `streamChat`; tests use mocks.
 */
export type DedupLlmCall = (
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
) => Promise<string>

// ──────────────────────────────────────────────────────────────────
// Stage 1: extract summaries (no LLM)
// ──────────────────────────────────────────────────────────────────

/**
 * Build an EntitySummary from a single page's path + content.
 * `pathRelativeToProject` should be the canonical wiki-relative
 * form (`wiki/entities/foo.md`) so callers downstream can derive
 * slugs consistently.
 */
export function extractEntitySummary(
  pathRelativeToProject: string,
  content: string,
): EntitySummary | null {
  const { frontmatter, body } = parseFrontmatter(content)
  if (!frontmatter) return null
  const type = stringField(frontmatter.type) ?? "unknown"
  const title = stringField(frontmatter.title) ?? slugFromPath(pathRelativeToProject)
  const description = stringField(frontmatter.description) ?? firstBodyParagraph(body)
  const tags = arrayField(frontmatter.tags)
  return {
    slug: slugFromPath(pathRelativeToProject),
    path: pathRelativeToProject,
    type,
    title,
    description: description ? truncate(description, 200) : undefined,
    tags,
  }
}

/**
 * Group the pages that share a slug – a concept and an entity page of one
 * name – from their paths alone, with no model call (#109). The detector
 * names pages by slug, so it cannot tell such pages apart; each is named
 * here by its page id, its path under `wiki/` without `.md`. Groups in
 * `notDuplicates` are left out, as the detector's are.
 */
export function sameSlugGroups(
  summaries: EntitySummary[],
  notDuplicates: string[][],
): DuplicateGroup[] {
  const pageIdsBySlug = new Map<string, string[]>()
  for (const s of summaries) {
    const pageId = pageIdFromPath(s.path)
    pageIdsBySlug.set(s.slug, [...(pageIdsBySlug.get(s.slug) ?? []), pageId])
  }
  const notDupSet = new Set(notDuplicates.map(normalizeGroupKey))
  const groups: DuplicateGroup[] = []
  for (const [slug, found] of pageIdsBySlug) {
    const pageIds = [...found].sort()
    if (pageIds.length < 2 || notDupSet.has(normalizeGroupKey(pageIds))) continue
    groups.push({
      slugs: pageIds,
      reason: `Pages share the slug "${slug}": ${pageIds.join(", ")}`,
      // Not "high": a shared name is not proof of one topic, and scheduled
      // maintenance merges high groups with no click.
      confidence: "medium",
    })
  }
  return groups
}

/** Convert an absolute filesystem path to a wiki-relative one
 *  (`<project>/wiki/entities/foo.md` → `wiki/entities/foo.md`). */
export function toWikiRelative(projectPath: string, absPath: string): string {
  const pp = normalizePath(projectPath)
  const norm = normalizePath(absPath)
  if (norm.startsWith(`${pp}/`)) return norm.slice(pp.length + 1)
  return norm
}

/** A page's id, its path under `wiki/` without `.md`: `wiki/concepts/foo.md` → `concepts/foo`. */
export function pageIdFromPath(path: string): string {
  return path.replace(/^wiki\//, "").replace(/\.md$/, "")
}

/**
 * The pages a group's name names, from pages with paths relative to the
 * project (`wiki/concepts/foo.md`): by its page id (`concepts/foo`), else
 * by its slug among the entity and concept pages, which the scan reads.
 * A slug shared by pages names them all (#109, #114).
 */
export function pagesNamed<T extends { path: string }>(pages: T[], name: string): T[] {
  return name.includes("/")
    ? pages.filter((p) => p.path === `wiki/${name}.md`)
    : pages.filter((p) =>
      (p.path.startsWith("wiki/entities/") || p.path.startsWith("wiki/concepts/"))
      && p.path.endsWith(`/${name}.md`))
}

/**
 * Why a merge refuses a slug that names more than one page, rather than
 * merging one of them (#109); null when it names at most one. The merge
 * and the Maintenance screen's card both refuse with it (#126).
 */
export function ambiguousSlugRefusal<T extends { path: string }>(pages: T[], slug: string): string | null {
  const found = pagesNamed(pages, slug)
  if (found.length < 2) return null
  return `Slug "${slug}" names ${found.length} pages: ${found.map((p) => pageIdFromPath(p.path)).join(", ")}`
}

/**
 * The page ids of every page a group's names name, when two of those pages
 * share a slug: a same-slug group (#109), or a group naming such a slug
 * bare. Null when no two of them do, so the group needs no judging (#135).
 */
export function sharedSlugCandidates<T extends { path: string }>(pages: T[], group: DuplicateGroup): string[] | null {
  const pageIds = [...new Set(group.slugs.flatMap((name) => pagesNamed(pages, name).map((p) => pageIdFromPath(p.path))))]
  const slugs = pageIds.map(slugFromPath)
  return new Set(slugs).size < slugs.length ? pageIds : null
}

function slugFromPath(path: string): string {
  const base = path.split("/").pop() ?? path
  return base.replace(/\.md$/, "")
}

function stringField(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim() !== "") return v.trim()
  return undefined
}

function arrayField(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
}

function firstBodyParagraph(body: string): string | undefined {
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean)
  // Skip leading h1/h2 lines so the description isn't just the title again.
  for (const line of lines) {
    if (line.startsWith("#")) continue
    if (line.startsWith("|")) continue // table — too noisy
    return line
  }
  return undefined
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

// ──────────────────────────────────────────────────────────────────
// Stage 2: LLM-driven duplicate detection
// ──────────────────────────────────────────────────────────────────

const DETECTOR_SYSTEM_PROMPT = `You are a wiki maintenance assistant. You will receive a list of entity / concept pages from a wiki. Identify groups of slugs that likely refer to the same underlying topic under different names — for example:

- Same name in two languages (English vs Chinese, etc.)
- Plural vs singular form (e.g. "dpao" vs "dpaos")
- Abbreviation vs full form (e.g. "vfa" vs "volatile-fatty-acids")
- Synonyms in the same language
- The same proper noun spelled differently

Output ONLY valid JSON. No prose, no markdown fences, no explanation outside the JSON. The schema is:

{
  "groups": [
    {
      "slugs": ["slug-a", "slug-b"],
      "reason": "Both refer to X; first is English, second is Chinese.",
      "confidence": "high"
    }
  ]
}

Rules:
- Only include groups of 2 or more slugs from the input list.
- "high" = clearly the same entity, only naming differs.
- "medium" = likely the same but context-dependent.
- "low" = uncertain; user should review carefully.
- Never invent slugs that aren't in the input.
- If no duplicates exist, output {"groups": []}.
- Pages of different \`type\` (e.g. an entity and a concept) usually should NOT be grouped — only group across types when they're unambiguously the same thing.`

/**
 * Run the LLM duplicate-detector. The caller hands in summaries
 * (typically every entity + concept page in the wiki) and a
 * function that wraps an LLM call. Returns parsed, validated
 * groups — invalid entries (slugs not in the input, single-element
 * groups) are filtered out so the caller never sees garbage. A
 * reply that cannot be read rejects with DetectorReplyUnreadableError.
 *
 * Already-confirmed-not-duplicate groups passed in `notDuplicates`
 * are filtered out before returning so the same false positive
 * doesn't keep appearing on every run.
 */
export async function detectDuplicateGroups(
  summaries: EntitySummary[],
  llmCall: DedupLlmCall,
  options: { signal?: AbortSignal; notDuplicates?: string[][] } = {},
): Promise<DuplicateGroup[]> {
  if (summaries.length < 2) return []

  const userMessage = buildDetectorUserMessage(summaries)
  const response = await llmCall(DETECTOR_SYSTEM_PROMPT, userMessage, options.signal)
  const parsed = parseDetectorResponse(response)

  const validSlugs = new Set(summaries.map((s) => s.slug))
  const notDupSet = new Set(
    (options.notDuplicates ?? []).map((g) => normalizeGroupKey(g)),
  )

  return parsed
    .map((g) => ({ ...g, slugs: g.slugs.filter((s) => validSlugs.has(s)) }))
    .filter((g) => g.slugs.length >= 2)
    .filter((g) => !notDupSet.has(normalizeGroupKey(g.slugs)))
}

function buildDetectorUserMessage(summaries: EntitySummary[]): string {
  const lines = summaries.map((s) => {
    const tagPart = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : ""
    const descPart = s.description ? ` — ${s.description}` : ""
    return `- type=${s.type}, slug=${s.slug}, title=${JSON.stringify(s.title)}${tagPart}${descPart}`
  })
  return `## Wiki pages to scan (${summaries.length} entries)\n\n${lines.join("\n")}\n\nReturn duplicate groups as JSON only.`
}

/**
 * Tolerant JSON extraction. The LLM might wrap output in code
 * fences (\`\`\`json), prepend "Sure, here you go:", or trail
 * with a polite "Let me know if...". Pull the first {…} block
 * with balanced braces and parse it. A reply with no readable
 * `groups` list throws DetectorReplyUnreadableError, so a garbled
 * reply is never taken for "no duplicates found" (#108).
 */
export function parseDetectorResponse(raw: string): DuplicateGroup[] {
  const jsonText = extractFirstJsonObject(raw)
  if (!jsonText) throw new DetectorReplyUnreadableError("no complete JSON object")
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new DetectorReplyUnreadableError("invalid JSON")
  }
  const groupsRaw = (parsed as { groups?: unknown } | null)?.groups
  if (!Array.isArray(groupsRaw)) throw new DetectorReplyUnreadableError("no groups list")

  const out: DuplicateGroup[] = []
  for (const g of groupsRaw) {
    if (!g || typeof g !== "object") continue
    const obj = g as Record<string, unknown>
    // A slug named twice is one page, not two (#109).
    const slugs = Array.isArray(obj.slugs)
      ? [...new Set(obj.slugs.filter((s): s is string => typeof s === "string"))]
      : []
    if (slugs.length < 2) continue
    const reason = typeof obj.reason === "string" ? obj.reason : ""
    const confidence: DuplicateGroup["confidence"] =
      obj.confidence === "high" || obj.confidence === "medium"
        ? obj.confidence
        : "low"
    out.push({ slugs, reason, confidence })
  }
  return out
}

/** Extract the first balanced `{...}` substring from arbitrary text. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\") {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

// ──────────────────────────────────────────────────────────────────
// Stage 2b: judge pages that share a slug (#135)
// ──────────────────────────────────────────────────────────────────

/** The judge's system prompt holds this phrase, and no other prompt does:
 *  a live test tells the judge's calls from the detector's by it. */
export const JUDGE_PROMPT_MARKER = "Some wiki pages share a file name"

const JUDGE_SYSTEM_PROMPT = `You are a wiki maintenance assistant. ${JUDGE_PROMPT_MARKER}, for example a concept page and an entity page both named "agent-skills". You will receive each candidate page with its path, title and full content. Decide which of them describe one and the same topic, so that they should be merged into one page.

Output ONLY valid JSON. No prose, no markdown fences, no explanation outside the JSON. The schema is:

{
  "groups": [
    {
      "pages": ["concepts/example", "entities/example"],
      "reason": "Both describe X."
    }
  ]
}

Rules:
- Each group lists two or more of the given paths that are one topic.
- A page in no group is a topic distinct from every other page given.
- Pages that share a name but cover different things – for example a general idea and a specific product, person or tool of that name – are distinct: leave them out of any group.
- A page appears in at most one group.
- Never invent paths that aren't in the input.
- If no pages are one topic, output {"groups": []}.`

/** Each page's content is cut to this many characters in the judge's prompt,
 *  so one very long page cannot crowd the others out of the model's context. */
const JUDGE_PAGE_CHARS = 12_000

/** Pages the judge found to be one topic, named by page id. */
export interface JudgedTopic {
  pages: string[]
  reason: string
}

/**
 * Ask the model which of the candidate pages, which include pages sharing a
 * slug, are one topic (#135). Each page is given by its page id, title and
 * content. A reply that cannot be read, that holds a group with no pages
 * list, that names a page it was not given, or that places a page in two
 * groups rejects with DetectorReplyUnreadableError: every pair no group
 * holds is recorded as distinct, so a group it could not read or honour, or
 * a page named in another form, must not count as left out.
 */
export async function judgeSharedSlugPages(
  candidates: { pageId: string; content: string }[],
  llmCall: DedupLlmCall,
  signal?: AbortSignal,
): Promise<JudgedTopic[]> {
  const sections = candidates.map((c) => {
    const title = stringField(parseFrontmatter(c.content).frontmatter?.title) ?? slugFromPath(c.pageId)
    return `## Page: ${c.pageId}\nTitle: ${JSON.stringify(title)}\n\n${truncate(c.content, JUDGE_PAGE_CHARS)}\n`
  })
  const userMessage = `## Candidate pages (${candidates.length})\n\n${sections.join("\n---\n\n")}\nReturn the groups as JSON only.`
  const reply = await llmCall(JUDGE_SYSTEM_PROMPT, userMessage, signal)

  const jsonText = extractFirstJsonObject(reply)
  if (!jsonText) throw new DetectorReplyUnreadableError("judge: no complete JSON object")
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    throw new DetectorReplyUnreadableError("judge: invalid JSON")
  }
  const groupsRaw = (parsed as { groups?: unknown } | null)?.groups
  if (!Array.isArray(groupsRaw)) throw new DetectorReplyUnreadableError("judge: no groups list")

  const given = new Set(candidates.map((c) => c.pageId))
  const placed = new Set<string>()
  const topics: JudgedTopic[] = []
  for (const g of groupsRaw) {
    const obj = (g && typeof g === "object" ? g : {}) as Record<string, unknown>
    if (!Array.isArray(obj.pages)) {
      throw new DetectorReplyUnreadableError(`judge: a group with no pages list: ${JSON.stringify(g)}`)
    }
    const named: unknown[] = obj.pages
    const unknown = named.find((p) => typeof p !== "string" || !given.has(p))
    if (unknown !== undefined) {
      throw new DetectorReplyUnreadableError(`judge: names a page it was not given: ${JSON.stringify(unknown)}`)
    }
    const pages = [...new Set(named as string[])]
    if (pages.length < 2) continue
    const twice = pages.find((p) => placed.has(p))
    if (twice !== undefined) {
      throw new DetectorReplyUnreadableError(`judge: places a page in two groups: ${JSON.stringify(twice)}`)
    }
    for (const p of pages) placed.add(p)
    topics.push({ pages, reason: typeof obj.reason === "string" ? obj.reason : "" })
  }
  return topics
}

/** Each pair of candidates that no judged topic holds both of. */
export function distinctPairs(candidates: string[], topics: JudgedTopic[]): string[][] {
  const topicOf = new Map(topics.flatMap((t, i) => t.pages.map((p) => [p, i] as const)))
  const pairs: string[][] = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const [a, b] = [candidates[i], candidates[j]]
      if (topicOf.get(a) === undefined || topicOf.get(a) !== topicOf.get(b)) pairs.push([a, b].sort())
    }
  }
  return pairs
}

/** Every pair of candidates, each sorted. */
export function allPairs(candidates: string[]): string[][] {
  return distinctPairs(candidates, [])
}

/** Canonical key for a group — lowercased, sorted, comma-joined. */
function normalizeGroupKey(slugs: string[]): string {
  return [...slugs].map((s) => s.toLowerCase()).sort().join(",")
}

// ──────────────────────────────────────────────────────────────────
// Stage 3: merge a confirmed duplicate group
// ──────────────────────────────────────────────────────────────────

const MERGER_SYSTEM_PROMPT = `You are a wiki maintenance assistant. You will be given several wiki pages that all describe the same entity or concept under different names. Merge them into a single coherent wiki page.

Output the COMPLETE merged file (frontmatter + body). The first character of your response MUST be "-" (the opening of "---"). No preamble, no explanation outside the file.

Rules:
- Preserve every distinct factual claim from every input page.
- Eliminate redundancy (don't say the same thing twice across sections).
- Reorganize sections so the structure is logical for the unified topic, not a concatenation of inputs.
- Use [[wikilink]] syntax in the body where the inputs did.
- Frontmatter: keep the standard fields (type, title, created, updated, tags, related, sources). The caller will overwrite sources / tags / related / updated with deterministic unions afterward — your job is to produce a sensible body and reasonable frontmatter shape.
- Pick the most descriptive title. If the inputs use different languages, prefer the language that matches the majority of the body content.`

const FIELDS_TO_UNION = ["sources", "tags", "related"] as const

/**
 * Compute everything needed to merge a confirmed duplicate group:
 *   - LLM call to produce the merged canonical body, rejected with
 *     MergeReplyRejectedError when it fails the page merge's guard
 *   - Deterministic frontmatter union (sources, tags, related)
 *   - Canonical slug enforcement on title path
 *   - Cross-reference rewrites across every other wiki page, and in
 *     the canonical page's own content (#141)
 *   - Backup snapshot of all touched files
 *
 * Returns a MergeResult; the CALLER is responsible for actually
 * writing canonicalContent + each rewrite + deleting the merged-
 * away files + storing the backup. Splitting compute from I/O
 * keeps this testable.
 */
export async function mergeDuplicateGroup(
  req: MergeRequest,
  llmCall: DedupLlmCall,
  options: { signal?: AbortSignal; today?: () => string } = {},
): Promise<MergeResult> {
  const canonical = req.group.find((p) => p.slug === req.canonicalSlug)
  if (!canonical) {
    throw new Error(
      `canonicalSlug "${req.canonicalSlug}" is not in the group: ${req.group.map((p) => p.slug).join(", ")}`,
    )
  }
  if (req.group.length < 2) {
    throw new Error("mergeDuplicateGroup requires at least 2 pages in the group")
  }

  // 1. LLM body merge
  const userMessage = buildMergerUserMessage(req.group)
  const llmOutput = await llmCall(MERGER_SYSTEM_PROMPT, userMessage, options.signal)
  const rejection = mergeReplyRejection(llmOutput, req.group)
  if (rejection) throw new MergeReplyRejectedError(rejection)

  // 2. Frontmatter union (deterministic post-processing of LLM output).
  //    For each unioned field, fold every input page's values into
  //    the LLM output via mergeArrayFieldsIntoContent.
  let merged = llmOutput
  for (const page of req.group) {
    merged = mergeArrayFieldsIntoContent(merged, page.content, [...FIELDS_TO_UNION])
  }

  // 3. Stamp updated to today and force a sensible title.
  const today = (options.today ?? defaultToday)()
  merged = setFrontmatterScalar(merged, "updated", today)
  // If LLM output's frontmatter parses cleanly we leave its title;
  // if not, the application layer doesn't try to manufacture one.

  // 4. Cross-reference rewrites: the canonical page itself, and every
  //    other wiki page, that mentions a non-canonical slug needs its
  //    wikilinks / related entries rewritten to the canonical.
  //    A page id goes to the kept page's page id, so a path-style link
  //    stays path-style (#141).
  const canonicalPageId = pageIdFromPath(canonical.path)
  const slugRedirects = new Map<string, string>()
  for (const name of mergedAwayNames(req.group, req.canonicalSlug, req.otherWikiPages)) {
    slugRedirects.set(name, name.includes("/") ? canonicalPageId : req.canonicalSlug)
  }
  // The kept page's own links to a page it absorbed now name itself (#141).
  merged = rewriteCrossReferences(merged, slugRedirects)
  const rewrites: MergeResult["rewrites"] = []
  for (const page of req.otherWikiPages) {
    const rewritten = rewriteCrossReferences(page.content, slugRedirects)
    if (rewritten !== page.content) {
      rewrites.push({ path: page.path, newContent: rewritten })
    }
  }

  // 5. Backup: every touched file's PRE-merge content.
  const backup: MergeResult["backup"] = []
  for (const page of req.group) {
    backup.push({ path: page.path, content: page.content })
  }
  for (const r of rewrites) {
    const orig = req.otherWikiPages.find((p) => p.path === r.path)
    if (orig) backup.push({ path: orig.path, content: orig.content })
  }

  // 6. Pages to delete: every group member except the canonical.
  const pagesToDelete = req.group
    .filter((p) => p.slug !== req.canonicalSlug)
    .map((p) => p.path)

  return {
    canonicalContent: merged,
    canonicalPath: canonical.path,
    rewrites,
    pagesToDelete,
    backup,
  }
}

/**
 * The names a merge sends to the canonical page: each merged-away page's
 * name in the group, its bare slug where no page left after the merge
 * carries that slug, so a bare link to a page the group named by page id
 * does not dangle (#139), and its page id, so a path-style link to it does
 * not dangle either (#141).
 */
export function mergedAwayNames(
  group: { slug: string; path: string }[],
  canonicalSlug: string,
  otherWikiPages: { path: string }[],
): string[] {
  const mergedAway = group.filter((p) => p.slug !== canonicalSlug)
  const left = new Set(
    [...group.filter((p) => p.slug === canonicalSlug), ...otherWikiPages].map((p) => slugFromPath(p.path)),
  )
  const names = mergedAway.map((p) => p.slug)
  for (const page of mergedAway) {
    const bare = slugFromPath(page.path)
    if (!left.has(bare)) names.push(bare)
    names.push(pageIdFromPath(page.path))
  }
  return names
}

/**
 * The page merge's guard (page-merge.ts), applied to a duplicate merge:
 * the reply must carry readable frontmatter, and its body must keep at
 * least BODY_SHRINK_THRESHOLD of the longest input page's body. Returns
 * why the reply fails, or null when it passes.
 */
function mergeReplyRejection(
  reply: string,
  group: { slug: string; content: string }[],
): string | null {
  if (reply.trim() === "") return "the model's reply was empty"
  const parsed = parseFrontmatter(reply)
  if (parsed.frontmatter === null) {
    return "the model's reply has no readable frontmatter"
  }
  const longest = Math.max(...group.map((p) => parseFrontmatter(p.content).body.length))
  const minimum = Math.ceil(longest * BODY_SHRINK_THRESHOLD)
  if (parsed.body.length < minimum) {
    return `the model's reply body is ${parsed.body.length} characters, shorter than ${minimum} (${BODY_SHRINK_THRESHOLD * 100}% of the longest page's ${longest})`
  }
  return null
}

function buildMergerUserMessage(
  group: { slug: string; content: string }[],
): string {
  const sections = group.map((p, i) => {
    return [
      `## Page ${i + 1} (slug: ${p.slug})`,
      "",
      p.content,
      "",
    ].join("\n")
  })
  return [
    `These ${group.length} wiki pages have been confirmed by the user to describe the same topic.`,
    `Merge them into a single coherent page (the canonical slug will be "${group[0].slug}" or whichever the caller chose).`,
    "",
    sections.join("\n---\n\n"),
    "",
    "Now output the merged file. First character must be `-`.",
  ].join("\n")
}

/**
 * Rewrite cross-references to merged-away slugs throughout one
 * page's content. Three forms get rewritten:
 *
 *   1. `[[old-slug]]`, `[[old-slug|alias]]` and `[[old-slug#anchor]]` in
 *      the body — replace just the target portion, keep anchor and alias
 *      if present (#141). A path-style link is matched by a page-id key.
 *   2. `related: [..., old-slug, ...]` (inline form) — substitute
 *      old-slug with canonical inside the array, then dedup.
 *   3. `related:\n  - old-slug` (block form) — same substitution.
 *
 * `wiki/index.md`-style listings of files are out of scope here —
 * the caller handles index regeneration separately.
 */
export function rewriteCrossReferences(
  content: string,
  slugRedirects: Map<string, string>,
): string {
  let out = content

  // 1. Wikilinks in the body — [[slug]], [[slug|alias]], [[slug#anchor]].
  for (const [oldSlug, newSlug] of slugRedirects) {
    const escaped = escapeRegex(oldSlug)
    const re = new RegExp(`\\[\\[${escaped}(#[^\\]|]*)?(\\|[^\\]]+)?\\]\\]`, "g")
    out = out.replace(re, (_match, anchor, alias) => `[[${newSlug}${anchor ?? ""}${alias ?? ""}]]`)
  }

  // 2. & 3. `related` field — re-parse and rewrite.
  const existing = parseFrontmatterArray(out, "related")
  if (existing.length > 0) {
    const rewritten = existing.map((s) => slugRedirects.get(s) ?? s)
    // Deduplicate (case-insensitive, first-seen casing wins)
    const seen = new Set<string>()
    const unique: string[] = []
    for (const s of rewritten) {
      const k = s.toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      unique.push(s)
    }
    if (
      unique.length !== existing.length ||
      unique.some((s, i) => s !== existing[i])
    ) {
      out = writeFrontmatterArray(out, "related", unique)
    }
  }

  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function setFrontmatterScalar(
  content: string,
  field: string,
  value: string,
): string {
  const m = content.match(/^(---\n)([\s\S]*?)(\n---)/)
  if (!m) return content
  const [, open, body, close] = m
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const newLine = `${field}: ${value}`
  const lineRe = new RegExp(`^${escaped}:\\s*(?!\\[)([^\\n]*)`, "m")
  if (lineRe.test(body)) {
    const rewritten = body.replace(lineRe, newLine)
    return `${open}${rewritten}${close}${content.slice(m[0].length)}`
  }
  return `${open}${body}\n${newLine}${close}${content.slice(m[0].length)}`
}

function defaultToday(): string {
  return new Date().toISOString().slice(0, 10)
}

// ──────────────────────────────────────────────────────────────────
// Index rewriter — wiki/index.md-specific
// ──────────────────────────────────────────────────────────────────

/**
 * Remove entries for merged-away slugs from `wiki/index.md`.
 * Index files are typically formatted as bullet / link lists
 * grouped by section. This is a CONSERVATIVE rewriter:
 *   - Removes any whole line that contains a markdown link or
 *     wikilink to a merged-away slug.
 *   - Preserves all other content verbatim (other sections,
 *     intros, the canonical entry).
 * The caller (UI) shows the user a diff before writing so any
 * over-removal is visible.
 */
export function rewriteIndexMd(
  content: string,
  removedSlugs: Set<string>,
): string {
  if (removedSlugs.size === 0) return content
  const lines = content.split("\n")
  const out: string[] = []
  for (const line of lines) {
    if (lineRefersToSlug(line, removedSlugs)) continue
    out.push(line)
  }
  return out.join("\n")
}

function lineRefersToSlug(line: string, slugs: Set<string>): boolean {
  for (const slug of slugs) {
    const escaped = escapeRegex(slug)
    // Wikilink form: [[slug]] or [[slug|alias]]
    if (new RegExp(`\\[\\[${escaped}(\\|[^\\]]*)?\\]\\]`).test(line)) return true
    // Markdown link form: [...](slug.md) or [...](path/slug.md)
    if (new RegExp(`\\(([^)]*\\/)?${escaped}\\.md\\)`).test(line)) return true
    // Bare slug.md mention (rare but seen in raw lists), not the end of
    // a longer hyphenated slug (#139)
    if (new RegExp(`(?<!-)\\b${escaped}\\.md\\b`).test(line)) return true
  }
  return false
}
