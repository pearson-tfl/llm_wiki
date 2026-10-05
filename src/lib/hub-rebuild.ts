/**
 * One-off hub-page rebuild (#16 fix 3, ticket #19), run by the scheduled
 * maintenance tick after the duplicate scan. An agent writes a request
 * file listing hub pages; each is rewritten from the source summaries a
 * search by meaning finds for it, then the request is archived with each
 * hub's result.
 */
import { deleteFile, fileExists, readFile, writeFile } from "@/commands/fs"
import { buildDedupLlmCall } from "@/lib/dedup-runner"
import { computeContextBudget } from "@/lib/context-budget"
import { parseFrontmatter } from "@/lib/frontmatter"
import { BODY_SHRINK_THRESHOLD, setFrontmatterScalar } from "@/lib/page-merge"
import { mergeSourcesLists, parseSources, writeSources } from "@/lib/sources-merge"
import type { MaintenanceSkipReason } from "@/lib/scheduled-maintenance"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"

const REQUEST_PATH = ".llm-wiki/hub-rebuild-request.json"
const ARCHIVE_DIR = ".llm-wiki/hub-rebuild-archive"
/** The rewrite is a whole page written to disk: the dedup merge's cap. */
const HUB_REBUILD_MAX_TOKENS = 16_384
/** Pages asked of the search. Only source summaries among them are used,
 *  and concept and entity pages outnumber them, so ask deep; the text
 *  budget, not this, bounds what the model is given. */
const HUB_SEARCH_TOP_K = 200
const HUB_QUERY_MAX_CHARS = 2_000
/** A summary cut shorter than this is not worth offering. */
const HUB_MIN_SUMMARY_CHARS = 1_000

const SYSTEM_PROMPT = [
  "You rebuild a hub page of a personal wiki.",
  "Rewrite it as one synthesis of its current text and the source summaries given.",
  "Keep every fact the current page states, and add what the summaries say about the hub's topic.",
  "Link each source summary you draw on with a wikilink of the form [[sources/<file name without .md>]].",
  "Reply with the whole page: YAML front matter between --- lines, then the Markdown body.",
  "Write nothing before or after the page.",
].join("\n")

type HubResult =
  | { path: string; result: "rebuilt" }
  | { path: string; result: "rejected" | "failed"; reason: string }

interface HubRebuildOutcome {
  rebuilt: string[]
  rejected: string[]
  /** Set when a write was withheld: the request stays for the next run. */
  withheld: MaintenanceSkipReason | null
}

/**
 * Process the hub-rebuild request, if one is present. `blocker` is asked
 * before each hub and again before its write; a non-null answer stops the
 * run with the request left in place. Returns null with no request.
 */
export async function runHubRebuildRequest(
  pp: string,
  llmConfig: LlmConfig,
  today: string,
  blocker: () => Promise<MaintenanceSkipReason | null>,
): Promise<HubRebuildOutcome | null> {
  const requestPath = `${pp}/${REQUEST_PATH}`
  if (!(await fileExists(requestPath))) return null
  const raw = await readFile(requestPath).catch((err) => {
    throw new Error(`hub-rebuild request is unreadable: ${err instanceof Error ? err.message : String(err)}`)
  })
  const pages = parseRequest(raw)

  const llm = buildDedupLlmCall(llmConfig, HUB_REBUILD_MAX_TOKENS)
  const results: HubResult[] = []
  for (const path of pages) {
    const step = await rebuildHub(pp, path, llmConfig, today, llm, blocker)
    if ("withheld" in step) {
      return { ...tally(results), withheld: step.withheld }
    }
    results.push(step)
  }

  await writeFile(
    `${pp}/${ARCHIVE_DIR}/${fileStamp()}.json`,
    `${JSON.stringify({ archivedAt: new Date().toISOString(), pages, results }, null, 2)}\n`,
  )
  // The archive holds the request now; the request path is cleared so the
  // next tick does not rebuild the same hubs again.
  await deleteFile(requestPath)
  return { ...tally(results), withheld: null }
}

function parseRequest(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`hub-rebuild request is not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const pages = (parsed as { pages?: unknown } | null)?.pages
  if (!Array.isArray(pages) || !pages.every((p) => typeof p === "string")) {
    throw new Error('hub-rebuild request has no "pages" list of page paths')
  }
  return pages
}

function tally(results: HubResult[]): Omit<HubRebuildOutcome, "withheld"> {
  return {
    rebuilt: results.filter((r) => r.result === "rebuilt").map((r) => r.path),
    rejected: results.filter((r) => r.result === "rejected").map((r) => r.path),
  }
}

async function rebuildHub(
  pp: string,
  path: string,
  llmConfig: LlmConfig,
  today: string,
  llm: ReturnType<typeof buildDedupLlmCall>,
  blocker: () => Promise<MaintenanceSkipReason | null>,
): Promise<HubResult | { withheld: MaintenanceSkipReason }> {
  const failed = (reason: string): HubResult => ({ path, result: "failed", reason })
  const before = await blocker()
  if (before) return { withheld: before }
  // The request is agent-written: only a page under wiki/ is rewritten.
  if (!/^wiki\/(?:[^/]+\/)*[^/]+\.md$/.test(path) || path.split("/").includes("..")) {
    return failed("not a wiki page path")
  }
  const hubPath = `${pp}/${path}`
  if (!(await fileExists(hubPath))) return failed("page not found")

  try {
    const current = await readFile(hubPath)
    const parsed = parseFrontmatter(current)
    if (parsed.frontmatter === null) return failed("the page has no front matter")

    const summaries = await findSummaries(pp, current, llmConfig)
    if (summaries.length === 0) return failed("the search found no source summaries")

    const reply = await llm(SYSTEM_PROMPT, userMessage(path, current, summaries))
    const proposed = parseFrontmatter(reply)
    if (proposed.frontmatter === null) {
      return { path, result: "rejected", reason: "the rewrite has no front matter" }
    }
    const minLength = parsed.body.length * BODY_SHRINK_THRESHOLD
    if (proposed.body.length < minLength) {
      return {
        path,
        result: "rejected",
        reason: `the body shrank to ${proposed.body.length} characters, below ${Math.ceil(minLength)}`,
      }
    }

    // The model call took a while: re-read what gates a write.
    const after = await blocker()
    if (after) return { withheld: after }
    // An ingest that started and finished during the model call is not
    // seen by the gates; its write must not be lost to a stale read.
    if ((await readFile(hubPath)) !== current) return failed("the page changed during the rebuild")

    const linked = linkedSlugs(proposed.body)
    const sources = summaries
      .filter((s) => linked.has(s.slug))
      .reduce((all, s) => mergeSourcesLists(all, parseSources(s.content)), parseSources(current))
    // The hub keeps its own front matter: only sources and updated change.
    const rebuilt = setFrontmatterScalar(
      writeSources(`${parsed.rawBlock}${proposed.body}`, sources),
      "updated",
      today,
    )

    await writeFile(`${pp}/.llm-wiki/page-history/hub-rebuild-${fileStamp()}/${path.replace(/[/\\]/g, "_")}`, current)
    await writeFile(hubPath, rebuilt)
    return { path, result: "rebuilt" }
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err))
  }
}

interface Summary {
  path: string
  slug: string
  content: string
}

/** Source summaries a search by the hub's title and text finds, cut to
 *  the page budget left once the hub itself is counted. */
async function findSummaries(pp: string, hub: string, llmConfig: LlmConfig): Promise<Summary[]> {
  const embCfg = useWikiStore.getState().embeddingConfig
  if (!embCfg.enabled || !embCfg.model) throw new Error("search skipped: embeddings are off")
  const { frontmatter, body } = parseFrontmatter(hub)
  const query = `${String(frontmatter?.title ?? "")}\n\n${body.trim()}`.slice(0, HUB_QUERY_MAX_CHARS)

  const { searchByEmbedding, getLastEmbeddingError } = await import("@/lib/embedding")
  const hits = await searchByEmbedding(pp, query, embCfg, HUB_SEARCH_TOP_K)
  // searchByEmbedding answers a failed embedding fetch with no hits.
  const fetchError = hits.length === 0 ? getLastEmbeddingError() : null
  if (fetchError) throw new Error(`search failed: ${fetchError}`)

  const { pageBudget, maxPageSize } = computeContextBudget(llmConfig.maxContextSize)
  let room = pageBudget - hub.length
  const summaries: Summary[] = []
  for (const hit of hits.filter((h) => h.id.startsWith("sources/"))) {
    if (room < HUB_MIN_SUMMARY_CHARS) break
    const path = `wiki/${hit.id}.md`
    const content = (await readFile(`${pp}/${path}`).catch(() => "")).trim()
    if (!content) continue
    const cut = content.slice(0, Math.min(maxPageSize, room))
    summaries.push({ path, slug: hit.id.slice("sources/".length).toLowerCase(), content: cut })
    room -= cut.length
  }
  return summaries
}

function userMessage(path: string, hub: string, summaries: Summary[]): string {
  return [
    `## Hub page: ${path}`,
    "",
    hub,
    "",
    "## Source summaries",
    ...summaries.flatMap((s) => ["", `### ${s.path}`, "", s.content]),
  ].join("\n")
}

/** Source-summary slugs the body links to: `[[name]]`, `[[sources/name]]`
 *  or `[[wiki/sources/name|label]]`, in any case. */
function linkedSlugs(body: string): Set<string> {
  const slugs = new Set<string>()
  for (const match of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = match[1].trim().toLowerCase().replace(/\.md$/, "").replace(/^(?:wiki\/)?sources\//, "")
    if (!target.includes("/")) slugs.add(target)
  }
  return slugs
}

function fileStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}
