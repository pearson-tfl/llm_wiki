# Teardown: John's wiki ingestion pipeline and health tools compared with the LLM Wiki app (#15)

Research report for pearson-tfl/llm_wiki#15. Written 5 Oct 2026, 22:00–23:30 UTC, by lane `llmw-15-teardown`. It was read-only on both systems: no ingest or sweep run, no edit to either pipeline, no launchd change, no app launch or quit, and no write to any wiki vault.

## 1. Summary

**Top recommendation: the app should take John's index-freshness discipline.** John's pipeline re-indexes after every sweep and again nightly. The app should do the same for its vector store, starting with one full re-index of the Agent Harness Wiki vault before the #20 consolidation runs.

The #14 fixes merged on 5 Oct (#17 candidate search, #18 scheduled duplicate scan, #19 hub rebuild) all depend on that vector store. Measured today, it cannot see a large part of the vault:
- 41% of concept pages (558 of 1,356) and 37% of entity pages (389 of 1,058) have no vectors under the id the new code looks up.
- 195 of 319 source summaries are unreachable by the hub rebuild.
- 280 pages have no vectors at all.
- Merges and hub rebuilds never re-embed what they write.

Installed as they stand, the fixes would find existing pages by meaning among only about 60% of the concept and entity pages (1,467 of 2,414).

**Outcome on the same measure.**

| Wiki | Concept pages with one source | Concept and entity pages per source |
|---|---|---|
| The app | 98.5% | 7.6 |
| John's andrew-pain | 34.0% | 1.6 |
| John's st-peters | 36.7% | 0.8 |

John's session-memory wiki, written by an older name-only compiler, shows the app's failure (section 5.4).

**What makes the difference.** John's generation model has Read, Edit and shell tools over the whole domain. It searches before writing (about 580 ad hoc directory searches plus 643 lookup-helper calls on 5 Oct) and edits pages in place. The app's model runs with tools off and sees only what the prompt carries.

**Where each side is stronger.**
- **The app is stronger after the fact:** duplicate detection by meaning, a guarded merge, hub rebuild, and structural and semantic lint in code.
- **John's pipeline has none of that.** Its last lint was 12 Jun 2026 and its lint has no duplicate check.
- **John's side is stronger on run control and records:** a per-source ledger, per-run logs, a lock, a kill switch, and git snapshots every five minutes.

**Neither side checks, at creation time, whether a new title means the same as an existing page.**

Recommendations are in section 8, ordered by value. Section 9 lists defects found along the way (SUGGESTED – not in original scope). Three of those defects affect #20's live proof directly:
- duplicate merges do not rewrite folder-prefixed links or index lines;
- the #29 cut-off check cannot fire on the Claude Code CLI provider the vault uses;
- the duplicate scan covers only entities and concepts.

## 2. Method and what was read

**Path prefixes used below.**
- `app:` – this worktree, `/Users/johnp/Code/llm_wiki-worktrees/llmw-15-teardown`, estate head `dba7169` (5 Oct 2026 14:13 BST).
- `AHR:` – `/Users/johnp/Code/Agent-Harness-Reconfig`, HEAD `447d21f4`.
- `ST:` – `/Users/johnp/Code/Shared-Tools`, HEAD `0038c30`.
- `vault:` – `/Users/johnp/Code/Obsidian/jep-ai-wiki-1.0` (John's Obsidian vault).
- `exp:` – `/Users/johnp/Code/Agent-Harness-Reconfig/Agent-Harness-Wiki-Experiment` (the app's project, the Agent Harness Wiki vault).

**Installed build versus head.**
- `/Applications/LLM Wiki.app` reports 0.6.12 (`defaults read … CFBundleShortVersionString`). Its binary is dated 4 Oct 15:31.
- Estate commit `b2e82d5` (4 Oct 15:23, the upstream 0.6.12 merge) is the last estate commit before that time (`git log --before='2026-10-04 15:31' -1 estate`).
- So the installed app is `b2e82d5`. Everything merged on 5 Oct is on estate but not installed: #17, #18, #19, #22, #24, #27 and #29 (`git log --first-parent estate`).
- Below, "head" means `dba7169` and "installed" means `b2e82d5`. `git diff --stat b2e82d5 dba7169` shows that lint, enrich-wikilinks, graph analysis, search, review, sweep-reviews, scheduled import, file sync, source lifecycle and the CLI transport are identical in both.

**How the work was split.** Nine read-only sub-agents each covered one slice and returned findings with `path:line` citations:
1. AHR `ops/wiki-ingest` core
2. Intake and the Shared-Tools inbox pipeline
3. Wiki health and lint tools across the Mac
4. AHR session-memory work (#1918, #2278, #2281, #58)
5. App ingest passes
6. App page merge, review and queue
7. App dedup, maintenance and lint
8. App search, embeddings and other writers
9. Live vault measurements

The load-bearing claims were then re-checked first-hand by this lane (appendix A): the vector-id mapping, the vector-store coverage counts, the duplicate-merge link regex, the scan scope, the CLI transport's ignored output cap, the sweep's tool grants, the lookup helper's search command, and the citation-hook failure count.

**Credentials.** `~/Library/Application Support/com.llmwiki.app/app-state.json` holds API keys. Only provider, model, embedding and schedule fields are reported here. `~/.claude-ingest/miniflux.env` and `~/.claude-seat-tokens/` hold John's pipeline credentials and were not read.

**Already identified (#14), not re-derived.** At `b2e82d5` the app's ingest showed the model only the 200 newest pages through `wiki/index.md`, and never used embeddings to choose existing pages. One correction from re-measurement: the single-source concept count is 1,335 of 1,356 (98.5%), not 1,330. The #14 count split `sources:` on commas, and 5 single-source pages have commas in the filename (`/tmp/llmw15/vault_stats.py` over `exp:wiki/concepts`).

## 3. Measured outcome on both sides

Both sides were measured by the same script (`/tmp/llmw15/vault_stats.py`), which parses the frontmatter `sources:` field in inline or block form.

| Wiki (writer) | Concept pages | One source | Entity pages | One source | Concept+entity pages per source page |
|---|---|---|---|---|---|
| App, `exp:` (app ingest) | 1,356 | 1,335 (98.5%) | 1,058 | 951 (89.9%) | 7.6 (2,414 / 319) |
| andrew-pain (sweep.sh) | 312 | 106 (34.0%) | 247 | 123 (49.8%) | 1.6 (559 / 344) |
| st-peters (sweep.sh) | 49 | 18 (36.7%) | 67 | 24 (35.8%) | 0.8 (117 / 141) |
| curry-for-charity (sweep.sh) | 20 | 6 (30.0%) | 5 | 3 | 0.4 |
| session-memory (old Shared-Tools compiler), body `## Sources` | 4,327 | 2,262 (52.3%) | 2,879 | 1,232 (42.8%) | 2.9 |
| session-memory, frontmatter (stale) | 4,327 | 4,270 (98.7%) | 2,879 | 2,879 (100%) | – |

Other app folders are also nearly all single-source: findings 1,708 of 1,711, comparisons 313 of 318, queries 640 of 642.

**Caveats.**
- andrew-pain was being re-ingested by hand while it was measured: 187 ledger records were marked done on 5 Oct (`/tmp/llmw15/ledger_stats.py`).
- andrew-pain's articles share one tight domain (Google Ads), which raises page sharing on its own.
- The app's corpus is dense reference documentation that has had nine days of ingest.
- The comparison is fair as an outcome but does not prove the pipeline is the only cause.

**Indexes.**
- The app's index holds exactly 200 links, all under "Recently Updated" (`grep -o '\[\[[^]]*\]\]' exp:wiki/index.md | wc -l` → 200; #14).
- andrew-pain's index holds 962 links against 967 pages, with a count in each section heading.
- `exp:wiki/overview.md` is still the 210-byte creation stub (`wc -c`; last changed 22 Aug).

**Surface near-duplicates (slug checks only).**
- **App** (`/tmp/llmw15/near_dups.py`, `/tmp/llmw15/jaccard.py`):
  - 3 slugs exist as both a concept and an entity (`agent-skills`, `openclaw-code-mode`, `openclaw-dreaming`), and 1 as a comparison and an entity (`openclaw-sandbox-backends`) (`comm -12` over folder listings).
  - 7 entity plural pairs, such as `openclaw-agent-cli` and `openclaw-agents-cli`.
  - `todo-write` and `todowrite`; `claude-3-7-sonnet` and `claude-sonnet-3-7`.
  - 8 concept pairs and 42 entity pairs with at least 75% word overlap.
- **andrew-pain, st-peters, curry-for-charity:** no concept–entity or plural collisions (`/tmp/llmw15/near_dups_john.py`).
- **John's ai-tools-apotheosis:** `concepts/Vibe Coding.md` and `concepts/VibeCoding.md` (`/tmp/llmw15/probe.py`).

Slug checks find only surface duplicates. The app's real problem, as #14 says, is concepts that never merge.

## 4. John's side

### 4.1 Intake: what feeds what

| Route | Trigger (live state) | Writes to | Source identity |
|---|---|---|---|
| Obsidian Web Clipper, domain templates | manual | `vault:wikis/<domain>/raw/articles` with `domain` and `ingest:` frontmatter (`AHR:ops/wiki-ingest/clipper-templates/andrew-pain.json`) | path, then content hash in the ledger |
| Miniflux poller | **not loaded**: `launchctl print …wiki-ingest-miniflux` → "Bad request."; last per-run log 26 Aug. `AHR:ops/wiki-ingest/MINIFLUX.md:79-93` wrongly says it is loaded | `raw/articles`, atomic `.part` then rename (`miniflux-poll.py:306-310`) | exact `source_url` string within one domain, no URL normalisation (`miniflux-poll.py:195-208`) |
| Session archiver | launchd `com.user.session-memory-archiver`, every 1800 s, `runs = 73`, stdout and stderr to `/dev/null` (`launchctl print`) | `wikis/session-memory/raw/transcripts` (31,341 files) plus domain copies by project-slug rule (`archive-claude-history.py:122-126`) | session id plus file-size growth only (`:406-418`); no content hash |
| Shared-Tools inbox pipeline | launchd `com.jeptech.inbox-pipeline`, 02:00, `runs = 2`, exit 0 | `~/Code/pre-wiki-ingest/inbox-pipeline/converted/`, which **no code reads** (grep across AHR `ops`, Shared-Tools and skills) | SHA-256 of content, rename-proof (`ST:inbox_pipeline/pipeline.py:71-80`, `:405-408`) – the strongest identity in the estate |
| `/pre-ingest-catalogue`, `/pre-ingest-promote`, `/wiki-save` | manual slash commands in `~/.claude/commands/` (prompt files, not skills) | staging `INDEX.md`; copies into `raw/`; chat summaries into `raw/llm-chat-transcripts` | slug match judged by the agent (`pre-ingest-catalogue.md:65-67`) |
| Clipper "Wiki Experiment" template and `ST:Send-To-AH-Wiki.sh` | manual | `exp:raw/sources` – **the app's** project (`clipper-templates/llm-wiki-experiment/wiki-experiment.json:4-24`; `Send-To-AH-Wiki.sh:9`) | none; a name clash gives `name (2).md` (`Send-To-AH-Wiki.sh:31-40`) |
| Image sweep for the app's project | launchd `com.jeptech.wiki-experiment-images`, WatchPaths on `exp:raw/sources`, `runs = 6` | rewrites `exp:raw/sources/*.md` in place (`experiment-images.py:282-294`) | – |

### 4.2 The sweep: `AHR:ops/wiki-ingest/sweep.sh`

**Picking sources.**
- The sweep walks `vault:wikis/*/` (`sweep.sh:1312-1322`) and lists `raw/articles/*.md`. Except on the day poll, it also lists transcripts (`:895-920`).
- Per-candidate gates (`:995-1176`):
  - `ingest: review` is never taken;
  - kill switch `~/.claude-ingest/KILL`;
  - 06:00 batch deadline;
  - holds;
  - 60-second settle;
  - content hash against the ledger;
  - "modified after ingest" hold.
- A domain whose ledger is empty and has no `.seeded` marker is skipped with an alert (`:941-953`). This is why session-memory, bb-signal-prototype, ai-tools-apotheosis and bb-consultants are never ingested.
- `seat-routing.conf:12-14` picks a billing seat, not a wiki.

**The model and its tools.**
- Each phase runs `claude -p --system-prompt-file <prompt> --allowedTools <list> --permission-mode bypassPermissions --model "$INGEST_MODEL"` in the domain root under `CLAUDE_CONFIG_DIR=~/.claude-ingest` (`sweep.sh:688-694`).
- `INGEST_MODEL` defaults to `claude-sonnet-5` (`:75`).
- Phase 1 is granted `Read Bash` (`:782`). Phase 2 is granted `Read Write Edit Bash` (`:829`).
- No timeout, turn cap or budget is set (`:676-707`; grep finds none).
- Sources over 200,000 bytes are split into parts (`:83`, `:367-400`).

**What the model sees.**
- **Phase 1** gets an ingest-context block and the source:
  - domain, slug and kind;
  - incremental or full mode;
  - "previously ingested" from the ledger;
  - "Pages written earlier in this run";
  - the helper paths (`sweep.sh:732-780`).
- Phase 1 must answer, for each entity and concept, whether the wiki already covers it, using the helper (`prompts/analysis.md:28-66`).
- **Phase 2** gets the context block plus phase 1's analysis, **not the source text** (`sweep.sh:819-820`). It writes pages itself with its tools.

**Finding existing pages: `topic_lookup.sh`.**
- **EXACT:** a disk `-f` test on each path the model names (`topic_lookup.sh:64-66`).
- **NEAR:** `qmd search -c <domain> --all --files -- "<topic>"`, a keyword (BM25) search capped at 100 rows that prints `qmd://` identifiers only (`:73`, `:80-98`).
- `qmd query`, the vector path, is avoided because it writes a cache (`:15-16`).
- The prompt forbids the model to read `wiki/index.md` or run its own lookups (`prompts/generation.md:18-23`).
- In practice the model browses the domain itself. Across 407 ingest transcripts in `~/.claude-ingest/projects` (all dated 5 Oct) there are:
  - 643 helper calls;
  - about 580 ad hoc `ls`, `grep` and `find` calls against the wiki;
  - 2,276 Read and 1,874 Edit calls;
  - 2 reads of `index.md` despite the ban.

  So in effect **every page in the domain is reachable**, through the model's own tool use.

**Update versus create.**
- The prompts say an existing page must be updated, not duplicated, and that a page written earlier in the run counts as covered (`prompts/generation.md:25-28`, `:45-46`).
- If the helper fails, no new entity or concept page may be made (`:33-35`).
- The script enforces only the source page:
  - it must be `wiki/sources/<slug>.md` (`sweep.sh:850-853`);
  - any other new file in `wiki/sources/` is moved out and fails the ingest (`:831-849`, #3183).
- Provenance fields are stamped by script (`:419-504`).
- Nothing in code checks create-versus-update for entity or concept pages.
- Updates are surgical Edit calls, not whole-page rewrites.

**Index.** `index_insert.sh` keeps the model out of the index.
- It finds `## <Section> (N)` and refuses a missing or duplicated heading (`:116-141`).
- It refuses a duplicate link by exact, case-sensitive target (`:163-185`).
- It inserts sorted and increments N (`:184-201`).
- It writes atomically (`:215-216`).
- It has no cap. It has no audit either: the andrew-pain index header says 243 entities against 245 files, and 3 pages are missing.

**After writing.**
- A source-page existence check, the provenance stamp, then once per sweep `qmd update`, `qmd embed` and a collection check (`sweep.sh:1346-1358`).
- No link check, lint, frontmatter validation of entity or concept pages, or consolidation.
- The prompt says a vault hook blocks uncited pages (`prompts/generation.md:130-131`). That hook (`vault:.claude/settings.local.json:21`, `:30`) uses a relative path, `.claude/scripts/check-wiki-citations.sh`. It fails on every ingest Write and Edit: 2,280 "No such file or directory" errors in the 407 transcripts, recounted by this lane. It is also a PostToolUse hook, which runs after the write.

**Scheduling.**

| Job | Live state |
|---|---|
| `com.jeptech.wiki-ingest-night` | loaded; 02:00; `sweep.sh --batch --domain st-peters`; `runs = 2`, exit 0. Every st-peters record is terminal, so each night is a no-op (`launchd-night.out`: "skipped 96 … already-terminal 96") |
| `com.jeptech.wiki-ingest-day` | not loaded (`Could not find service`) |
| `com.jeptech.wiki-ingest-miniflux` | not loaded (`Bad request.`) |

- andrew-pain is ingested only by hand: 193 `--only` runs across the logs.
- `capacity-check.py` is an offline estimator that the sweep never calls (`grep -c capacity sweep.sh` → 0).

**Observability.**
- **Ledger:** one JSON file per (domain, content hash) at `~/.claude-ingest/ledger/<domain>/<hash>.json` (`ledger.py:4-5`). It records status, attempts, first seen, ingested at, reason, `session_id` and image counts (`ledger.py:158-229`).
- **Ledger counts:**

| Domain | done | seeded-legacy | in-progress | held | failed |
|---|---|---|---|---|---|
| andrew-pain | 305 | 12 | 6 (five stale since 25–26 Aug) | 0 | 0 |
| st-peters | 64 | 32 | 0 | 0 | 0 |
| curry-for-charity | 0 | 55 | 0 | 2 | 0 |
| domestic | 2 | 0 | 0 | 0 | 0 |

- **Logs:** one per run, `~/Library/Logs/wiki-ingest/sweep-<UTC>.log`. There are 1,227 (21 MB) with no rotation.
- **Digest:** a one-line digest goes to `AHR:ops/map-loop/digest-queue.md` (`sweep.sh:1372-1376`). No loaded job consumes it.

**Failure handling.**
- **Locking and control:**
  - one global `flock` (`sweep.sh:191-203`);
  - a manual run fails fast with exit 75 (`:56-60`);
  - three strikes, then `failed` (`ledger.py:131-140`);
  - rate-limit backoff of 30, 60, 120 and 300 s, on stderr match only (`sweep.sh:676-707`);
  - atomic ledger writes with `O_EXCL` on first claim (`ledger.py:80-91`, `:176-181`).
- **Partial writes:**
  - Pages are not rolled back: a failed attempt's pages stay, and the code says so (`sweep.sh:1242-1247`).
  - The vault's safety net is `com.jeptech.jepaiwiki.autocommit`, a git commit and push every 300 s (`vault:setup/autocommit.sh:19-32`; `runs = 564`, exit 0).
  - With no timeout, a hung `claude -p` holds the global lock.

### 4.3 Health, lint and consolidation tools

**No health, lint, consolidation or duplicate tool runs on a schedule for any vault wiki.** Everything is a hand-run slash command in `vault:.claude/commands/`:

| Tool | What it does | Defects or limits |
|---|---|---|
| `/wiki-health` (`wiki-health.md:1-31`) | stubs, index sync, broken links; no model | substring index match; checks `wiki/${link}.md` only, so it over-reports links Obsidian resolves by name (`:24-29`) |
| `/wiki-lint` (`wiki-lint.md:1-26`) | orphans, broken links, existing contradictions, stale summaries, missing entities, gaps; model-driven | **no duplicate check** (`:7-22`). Last run on any domain 12 Jun 2026 (`st-peters/wiki/log.md:785`). andrew-pain has never been linted |
| `/wiki-audit-coverage` | raw headings against source Key Claims | hard-coded to `ai-tools-apotheosis` (`:13-14`) |
| `/wiki-reindex`, `/wiki-graph`, `/wiki-blast-radius` | qmd and keppi graph | keppi is out of service per the vault schema (`AHR:config/projects/jep-ai-wiki-1-0.md:324`), yet a 51.6 GB graph was rebuilt on 3 Oct (`stat ~/.keppi/graphs/1e2b8cc83592.db`) by a create-domain step; data volume 88% full (`df -h ~`) |

**Scheduled jobs that touch the vault.**
- `com.jeptech.qmd-nightly-embed` (03:00, `qmd update && qmd embed | tail -20`) keeps 1.66 M vectors fresh (`qmd status`). Its exit status is `tail`'s, so an embed failure reports 0.
- **No ingest or health tool reads those vectors.**
- `qmd collection list` shows 14 collections, missing `matt-pocock` and `bb-consultants`, so `topic_lookup.sh` would exit 5 for those domains.

**Disabled or dead tooling.**
- The `vault-pkm` plugin's link auditor is disabled (`~/.claude/settings.json:433`) and pinned to Haiku.
- The `karpathy-llm-wiki` skill is a dangling symlink.
- `wiki-lint` and `wiki-fold` are specified for porting under AHR #58 (open) but not built: `grep -rln 'wiki-lint|wiki_lint|wiki-fold|wiki_fold' AHR:ops ST:` finds nothing.

### 4.4 The session-memory work (AHR #1918, #2278, #2281, #58)

**State.**
- Nothing is built.
- The #2278 spec (`AHR:docs/specs/1918-session-memory-reseed-spec.md`, 489 lines) merged as docs only (`0639355f`, 26 Sep).
- Build tickets #2279–#2285 and #58 are open with no commits (`git log --all | grep`; `git branch -a`).

**Why the session-memory wiki fragmented: the old compiler's matching.**
- `ST:session_memory/session_memory_ingest.py` matched a page by name only: `_kebab(name).md` exists (`:376-382`, `:411-417`, `:443-449`).
- On a match it appended only a `[[sources/…]]` line, never extending the body (`:418-421`, `:450-453`).
- This adds to #1918: matched pages stayed one-paragraph stubs, the same symptom #14 reports for "Agent Harness Engineering".
- #1918's measurement found 42% of session-memory concept and entity pages have a near-twin title (`AHR:docs/research/1918-session-memory-corpus-measurement.md:27-29`).

**Match before mint (#2281), as specified and unbuilt.**
- A script-side lookup on title plus a one-line summary.
- Embedding similarity on local `nomic-embed-text` returns up to five scored pages.
- The model adds to a page above the threshold.
- The sweep then refuses and logs any new page scoring above the threshold. This is "model chooses, script verifies" (`spec:231-238`).
- The threshold is to be calibrated. The spec cites 0.82 as "the fork's shipped default" (`spec:192`). The app's duplicate runner actually passes 0.68 (`app:src/lib/dedup-runner.ts:37`, `:280`), so that citation is wrong for the path that matters.
- The spec has a one-off merge pass and a nightly duplicate count, but **no recurring merge** (`spec:243-250`), and no rule for keeping the lookup store current after the swap (`spec:233-234`).

**Hardening (#58).** The frozen-sort bug is still present: `ST:session_memory/session_memory_inject.py:46-65` sorts mixed filename families in reverse lexical order. The 769,565-byte `wikis/session-memory/wiki/index.md` still exists.

## 5. The app's side

### 5.1 Ingest: analysis pass

**Entry and inputs.**
- `autoIngest` takes a per-source lock and runs `autoIngestImpl` (`app:src/lib/ingest.ts:654-677`, `:735`).
- Inputs are the source text, `schema.md`, `purpose.md`, `wiki/index.md` and `wiki/overview.md` (`:807-813`).
- Long sources go through chunked analysis with a rolling 15,000-character digest and checkpoints (`:3350-3487`).

**The prompt (`buildAnalysisPrompt`, `:2379-2440`).**
- It asks for entities with a page-worthiness verdict and "reuse the exact title of an existing wiki page" (`:2355-2360`), concepts, arguments, connections, contradictions and recommendations.
- At head it adds a `## Topics` list (#17, `:2427-2428`).
- The index is labelled as a partial list of recently updated pages (`:2814-2815`).

**The call and output.**
- Temperature 0.1.
- The output is free Markdown. Only the Topics list is parsed: last heading wins, at most 20 topics, lines over 120 characters or ending in `.`, `!` or `?` stop it (`parseAnalysisTopics`, `:2838-2857`).

### 5.2 Ingest: candidate selection (#17 and #22, head only)

`selectExistingPageCandidates` (`ingest.ts:2890-2967`) runs after analysis.

**Exact path.**
- It walks all of `wiki/` and keys every `.md` file by lower-cased stem (`:2866-2881`).
- Each topic's `makeQuerySlug` (`app:src/lib/wiki-filename.ts:32-46`) that equals a stem is offered first (`:2915-2924`).
- `makeQuerySlug` strips punctuation without inserting hyphens, so "GPT-5.3" becomes `gpt-53`.

**Embedding search.**
- One vector query per topic name, 10 hits fetched and 3 kept (`ingest.ts:72-75`, `:2934-2947`).
- Hits are grouped from chunks with a blended score (`app:src/lib/embedding.ts:790-856`).
- There is **no similarity floor**, and ranking across topics is global: one topic can crowd out the others (`ingest.ts:2954-2965`).

**What reaches the prompt.**
- At most 12 pages, each a whole file trimmed to fit a block of 15% of the context budget (`:70`, `:78`, `:2828-2830`).
- On John's settings (`maxContextSize` 1,000,000 characters) that is a 150,000-character block.

**When search fails or is off.** A skip line is written to `log.md` (`:2921-2951`). One failure stops the remaining topics, though candidates already found are kept.

**New finding: id mismatch hides 41% of concept pages.** A hit is mapped to `wiki/${hit.id}.md` (`ingest.ts:2943`; the same in `app:src/lib/hub-rebuild.ts:209`). Pages embedded before commit `697ed61` ("qualify vector page identities", 27 Sep) are stored under a bare slug, so the mapped path does not exist and the hit is silently dropped (`ingest.ts:2944`). A read-only LanceDB count of `exp:.llm-wiki/lancedb`, table `wiki_chunks_v2` (appendix A, A2):

| Pages | Total | Folder-qualified vectors | Bare-slug vectors only | No vectors |
|---|---|---|---|---|
| All content pages | 5,795 | 3,888 | 1,627 | 280 |
| Concepts | 1,356 | 798 | – | – |
| Entities | 1,058 | 669 | – | – |
| Source summaries | 319 | 124 | – | – |

- So 558 concepts and 389 entities can be offered only by an exact slug match, never by meaning.
- The Rust hybrid search maps bare ids when the file name is unique (`app:src-tauri/src/commands/search.rs:414-417`). The TypeScript path used by ingest and hub rebuild does not.
- A forced re-index from Settings > Embedding migrates the ids (`app:src/lib/embedding.ts:249-273`, `:622-718`; `embedding-section.tsx:121-134`). It is the only caller.

### 5.3 Ingest: generation pass and write path

**The generation prompt (`ingest.ts:2445-2629`).** It carries:
- the role and rules;
- the source filename for `sources`;
- schema routing;
- what to generate, including "Do not generate wiki/index.md or wiki/overview.md" (`:2491`);
- frontmatter rules, review-block rules, purpose, the partial index and the overview;
- at head, "Existing Pages for This Source (update these in place)", saying a FILE block at a page's exact path will be merged (`:2577-2587`);
- the output format.

**The call.**
- The user message carries the analysis and the full source or digest (`:1180-1210`).
- The #14 spec lane's index and overview contradiction (b2e82d5 `ingest.ts:2436` against `:2519-2520`) is fixed at head (`:2574-2575`; `ingest.prompt.test.ts:344-358`).

**Overview.** The prompt still calls it "read-only; the application maintains it" (`:2575`), but no ingest code writes it. Model blocks for it are dropped (`:2106-2111`). The only writer is project creation (`app:src-tauri/src/commands/project.rs:194`). The vault's copy is the stub.

**Update versus create is decided only by path.** A FILE block at an existing path merges; any other safe path under `wiki/` creates (`:465-481`, `:2058-2269`). Schema routing can move a block to another folder before the merge (`:2135-2163`). So a model that writes a candidate's path with a different `type` creates a new page instead (inferred from code).

**Merge (`app:src/lib/page-merge.ts:97-214`).**
- `sources`, `tags` and `related` are unioned in code (`:111-115`, `:204`).
- `type`, `title` and `created` are locked (`:193-198`).
- The body is a model merge at temperature 0.1 (`ingest.ts:3495-3592`).
- A reply with no frontmatter, or a body under 70% of the larger input, is rejected (`page-merge.ts:55`, `:161-181`).
- Rejection falls back to the **incoming** body (`:151-157`), with the old body kept only in `.llm-wiki/page-history/`.
- A page owned only by this source has its body replaced without a model call (`:122-136`).
- A successful merge takes no backup (`page-merge.test.ts:466`).
- The vault's `page-history/` holds 22 backups for 5,798 pages (`ls`).

**Index.**
- `updateWikiIndexDeterministically` adds written paths to "Recently Updated" and slices to 200 (`ingest.ts:1745-1800`; #14).
- A separate Rust rebuild produces a full categorised index (`app:src-tauri/src/commands/project_maintenance.rs:287-354`), but only from a manual Maintenance button.

**Embedding after write.** Every written page except index, log and overview is embedded after the completeness gate (`ingest.ts:1604-1625`). Failures are swallowed to the console (`:1618-1620`).

**Cache.**
- A source whose identity and SHA-256 match, and whose written files all exist, skips the pipeline (`app:src/lib/ingest-cache.ts:67-99`, `ingest.ts:844-848`).
- So the 319 already-ingested sources will not grow existing pages after #17 is installed unless their cache entries go (inferred from code).

**Model and tools.**
- On the vault, ingest routes to the `claude-code-cli` preset with `claude-opus-5-5` and `localCliIsolation = true` (app-state, provider fields only).
- That adds `--tools ""` and an empty MCP config (`app:src-tauri/src/commands/claude_cli.rs:469-494`). The model has no tools.
- The CLI transport ignores `max_tokens` and `temperature` (`app:src/lib/claude-cli-transport.ts:196-209`) and finishes with `onDone()` without a truncation flag (`:253`, `:313`).

### 5.4 Review items

**Types and storage.** Types are contradiction, duplicate, missing-page, confirm and suggestion (`app:src/stores/review-store.ts:9-21`), saved to `.llm-wiki/review.json` with write errors swallowed (`app:src/lib/auto-save.ts:85-94`).

**Where duplicate items come from.** They are the ingest model's own opinion, formed from the capped index (`ingest.ts:2650-2689`). They come from no similarity check.

**State of `exp:.llm-wiki/review.json`.** 1,714 items:
- 87 duplicate, all unresolved;
- 266 contradiction, all unresolved;
- 1,115 suggestion unresolved;
- 245 missing-page auto-resolved;
- 1 judged by the model.

**Resolution.**
- The review view has no merge action (`grep -i "merge|dedup" review-view.tsx` → none).
- "Create Page" on a duplicate item writes a new page from the item's description (`review-view.tsx:259-286`, `:678-681`). If the stable name exists it writes a timestamped sibling (`app:src/lib/review-create-page.ts:100-121`).
- The automatic sweep resolves a duplicate only when an affected page disappears (`app:src/lib/sweep-reviews.ts:378-391`).
- Its model judge sees only the first 300 page names (`:182-184`).

### 5.5 Duplicate scan, merge, scheduled maintenance and hub rebuild

**The scan (upstream; scheduled at head by #18).**
- Only `wiki/entities` and `wiki/concepts` are read (`app:src/lib/dedup-runner.ts:161-168`, re-checked). That is 2,414 of 5,798 vault pages; findings (1,711), queries, methodology and comparisons are never scanned.
- Each page is summarised as slug, type, title, a 200-character description and tags (`app:src/lib/dedup.ts:129-147`).
- Each summary is embedded fresh on every scan, with no cache (`app:src/lib/dedup_embedding.ts:86-101`). Pairs at cosine ≥ 0.68 among the top 8 neighbours are chained into clusters and batched 80 to a model call (`dedup-runner.ts:36-38`, `dedup_embedding.ts:176-210`).
- The model labels groups high, medium or low (`dedup.ts:184-244`).
- A not-duplicates list is honoured. At head it is read strictly (`app:src/lib/dedup-storage.ts:36-52`).

**The merge (`dedup-runner.ts:413-505`).**
- One model call over the full group pages.
- Every touched file is backed up to `page-history/dedup-<time>/`.
- It writes the canonical page, rewrites links, deletes the losing pages with plain `deleteFile` (`:481-489`), and rewrites the index.
- At head:
  - a reply that is empty, lacks frontmatter or shrinks below 70% is rejected (`dedup.ts:444-459`);
  - a cut-off or cancelled reply is rejected (`dedup-runner.ts:121-129`);
  - merges wait for ingest and hold the project lock (`app:src/lib/dedup-queue.ts:431-481`).
- Link rewriting matches only `[[slug]]` and `[[slug|alias]]` (`dedup.ts:500-505`, re-checked). Folder-prefixed links such as `[[entities/slug]]`, which the app's own index writes, are not touched; the vault has 1,437 of them among 28,895 links.
- Losing pages are not removed from the vector store (section 9).

**Scheduled maintenance (#18, head).**
- On by default, every 24 hours (`app:src/lib/project-store.ts:366-372`). It checks every 10 minutes while the project is open (`app:src/lib/scheduled-maintenance.ts:43`, `:216-226`).
- It auto-merges only high-confidence groups without a not-duplicates pair (`:124-126`). It saves the rest for the Maintenance screen (`:147`).
- It records one JSON line per tick to `.llm-wiki/maintenance-runs.jsonl` (`:235-249`). No screen reads that file (grep over `src/**/*.tsx`).

**Hub rebuild (#19 and #27, head).**
- A request file `.llm-wiki/hub-rebuild-request.json` names hub pages (`hub-rebuild.ts:18`, `:88-123`).
- Each hub gets a vector search for up to 200 `sources/` hits, trimmed to budget, then one model call. The output is backed up first, checked against the page on disk under the lock, and shrink-checked (`:162-216`).
- It does not use the cut-off check (`hub-rebuild.ts:68`, re-checked) and does not re-embed the rewritten hub.

### 5.6 Lint, enrich-wikilinks and graph insights (unchanged since installed)

**Lint.** Lint runs only from the Lint view (`app:src/components/lint/lint-view.tsx:143-191`).
- **Structural lint** has three checks: orphan, no-outlinks and broken-link, with fuzzy fix targets (`app:src/lib/lint-structural-core.ts:102-224`).
- **Semantic lint** is off by default. It is one model call over the first 500 characters of every page, with no batching (`app:src/lib/lint.ts:205-356`).
- **Neither lint has a duplicate check.** Fixes are applied by click, without the lock or a backup.

**enrich-wikilinks is dead code.** It has no caller at head or installed, apart from test-helper comments (`grep -rn` over `src`, `src-tauri`, `mcp-server`). It was wired into Save to Wiki by `2cf576c` on 8 Apr 2026 and reverted by `82561c8` the next day.

**Graph insights** flag isolated pages, sparse communities and bridges for the graph view only (`app:src/lib/graph-insights.ts:135-214`).

### 5.7 Search and embeddings

**Embeddings.**
- Global setting. Live: local Ollama `qwen3-embedding:0.6b`, 1,024 dimensions.
- Pages are chunked at about 1,000 characters with 200 overlap, frontmatter stripped. Each chunk is embedded as title, heading path and text (`app:src/lib/text-chunker.ts:64-69`; `embedding.ts:353-380`).
- The store is LanceDB at `.llm-wiki/lancedb`, flat scan, no ANN index (`app:src-tauri/src/commands/vectorstore.rs:48-66`; no `create_index` in `src-tauri`).
- Each request times out after 8 s, with no retry on network errors (`search.rs:22`, `:1176-1207`).
- Embedding happens only at ingest write, deep-research save, API or MCP calls, or a manual re-index. Nothing backfills or checks coverage.

**Keyword search.** It reads every wiki file on every query, up to 10,000 files (`search.rs:349-412`). It is fused with vector hits by reciprocal rank (k = 60), and graph neighbours take 15–30% of result slots (`search.rs:497-693`).

**Who uses which search.**
- Chat, UI, API and MCP use this hybrid search.
- Ingest candidates and hub rebuild use vector-only search.
- The duplicate scan computes its own embeddings and does not use LanceDB.

### 5.8 Import and other writers

**Source watch.** This is the live automatic route into `exp:`. It is on with auto-ingest (app-state).
- A Rust watcher with a 60 s reconciliation (`app:src-tauri/src/commands/file_sync.rs:195-321`).
- Created and **modified** sources are enqueued (`app:src/lib/project-file-sync.ts:337-381`).
- Source identity is the path, not the content (`app:src/lib/source-identity.ts:8-24`).

**Scheduled import.** It is enabled on the vault but pointed at the project's own `raw/sources`. The code refuses that path on every scan and adds an error item each session (`app:src/lib/scheduled-import.ts:135-162`, `:437-447`; app-state `lastScan: null`).

**Ingest queue.**
- Pending and processing tasks persist and resume.
- 3 immediate retries.
- A 15-minute pause on usage limits.
- Done tasks are dropped (`app:src/lib/ingest-queue.ts:98-151`, `:949-1094`).

**Other writers create pages and never update existing ones:**
- deep research writes timestamped `wiki/queries/research-…` pages (`app:src/lib/deep-research.ts:54-76`, `:653-674`);
- Save to Wiki writes timestamped query pages and then feeds them back to ingest as a source (`app:src/components/chat/chat-message.tsx:547-631`);
- review "Create Page" (section 5.4).
- None takes the project lock, despite `app:src/lib/project-mutex.ts:4-9` saying so.
- The chat agent, API and MCP `write_page` path is create-only by default, verified and history-recorded (`app:src-tauri/src/agent/tools.rs:686-760`). Its lock is separate from the ingest lock.

**File history.** It is on in the vault and saturated at its 2,048-file cap (`ls exp:.llm-wiki/history | wc -l`; `app:src-tauri/src/commands/file_history.rs:9-13`). Ingest writes are labelled as human edits (`app:src-tauri/src/commands/fs.rs:1253-1260`). The vault is not under its own git: AHR tracks 11 of its files (`git ls-files Agent-Harness-Wiki-Experiment | wc -l`).

## 6. Comparison table

The installed app (`b2e82d5`) and head (`dba7169`) are split where they differ.

| Mechanism | John's pipeline | App, installed | App, head | Better today | Better on head |
|---|---|---|---|---|---|
| 1. Finding candidates | Model with Read and shell over the whole domain, plus EXACT disk test and BM25 helper (`topic_lookup.sh:64-98`); about 580 self-searches on 5 Oct | 200-entry index only (#14) | Exact stem plus vector top-3 per topic, max 12 pages, no floor, 41% of concepts invisible (5.2) | John | John on reach; app on meaning, once re-indexed |
| 2. What the model sees | Phase 2: analysis and context, not the source; reads any page on demand | Source, analysis, 200-entry index | Plus up to 12 candidate pages in full | John on reach; app on grounding | Mixed |
| 3. Update versus create | Model Edits pages in place; prompt rules; script enforces source slug only | Same path merges by model rewrite; arrays unioned, fields locked, 70% check | Same, plus "update these in place" | John on outcome (34% against 98.5% single-source) | John on outcome; app on write safety |
| 4. Near-duplicate prevention | BM25 names, run list, prompt; none by meaning (AHR #2281 unbuilt) | Model's REVIEW opinion only | #17 candidates; no post-generation check | Neither | Neither at creation; app after the fact |
| 5. Consolidation and health | Manual commands; last lint 12 Jun; no duplicate check | Manual dedup scan (never run on the vault), manual lint | Daily scan with high-confidence auto-merge, hub rebuild, manual lint | App | App |
| 6. Scheduling | launchd independent of any GUI, but only a no-op st-peters job is live; andrew-pain manual | Source watch while the app is open | Plus a maintenance tick while the project is open | App in practice | App in practice; John's design |
| 7. Observability | Per-source ledger, per-run logs, run transcripts | `log.md` lines, in-memory activity panel, `review.json` | Plus `log.md` candidate counts and `maintenance-runs.jsonl` (not shown) | John | John |
| 8. Failure handling | flock, kill switch, deadline, three strikes, holds, atomic ledger; no timeout, no page rollback; 5-minute git snapshots | Crash-safe queue, retries, usage pause, checkpoints, in-process lock; capped file history | Plus merge and ingest exclusion, merge reply checks, backups before merges | Mixed: app per write, John per run and recovery | Same |

## 7. Per-mechanism verdicts and evidence

**7.1 Candidates – John better today; head narrows the gap but is undercut by the vector store.**
- John's model reaches every page because it may search the domain itself (`sweep.sh:829`; transcript tallies in 4.2). The outcome shows it: 1.6 pages created per source against the app's 7.6.
- The app's #17 brings meaning-based matching, which John's keyword helper lacks (`topic_lookup.sh:73`). But it offers at most 12 pages with no similarity floor (`ingest.ts:70`, `:2940-2965`), and it cannot see 41% of concepts until a re-index (5.2).
- John's EXACT disk test answers "does this exact page exist" with no false absence. The app's exact-stem check is weaker, because `makeQuerySlug` drops hyphens at punctuation (`wiki-filename.ts:32-46`).

**7.2 What the model sees – mixed.**
- John's phase 2 never sees the source text, only phase 1's analysis (`sweep.sh:819-820`). That is a loss of grounding the app does not have (`ingest.ts:1180-1210`).
- The app's model sees nothing beyond its prompt (tools off, `claude_cli.rs:469-494`).

**7.3 Update versus create – John better on outcome, the app safer per write.**
- John's in-place Edit calls grow pages surgically, and nothing in code stops a model from damaging a page.
- The app's merge unions arrays and locks identity fields in code (`page-merge.ts:111-115`, `:193-204`). But it rewrites the whole body, can drop up to 30% (`:55`), and falls back to the incoming body (`:151-157`).

**7.4 Near-duplicate prevention – neither prevents at creation.**
- John's side relies on prompt rules over BM25 results. The app relies on prompt rules over vector results.
- Neither verifies after generation that a new page is not a near-twin. AHR #2281 specifies that check and it is unbuilt (`spec:231-238`).
- The app at head catches duplicates after the fact by daily scan. John's side has nothing after the fact, and its lint has no duplicate rule (`wiki-lint.md:7-22`). `concepts/Vibe Coding.md` beside `concepts/VibeCoding.md` survived two lint passes.

**7.5 Consolidation and health – the app is clearly better.** It has embedding-prefiltered model judging, a guarded merge with backups (`dedup-runner.ts:463-471`), hub rebuild and lint in code. John's side has hand-run prompts with heuristics that are wrong both ways (4.3).

**7.6 Scheduling – the app is better in practice, John's is better in design.**
- launchd jobs run without any app open, but the only live ingest job is a no-op (4.2). andrew-pain's 187 October ingests were manual.
- The app's maintenance runs only while the project is open (`scheduled-maintenance.ts:219`).

**7.7 Observability – John better.**
- The ledger answers "what happened to this source" per source and per attempt (`ledger.py:158-229`).
- The app keeps no per-ingest run record. Its activity panel is not persisted (`app:src/stores/activity-store.ts:23-24`), done queue tasks are dropped (`ingest-queue.ts:1036`), and `log.md` has counts but not which candidates were offered or used (`ingest.ts:2970-2981`).

**7.8 Failure handling – mixed.**
- The app guards individual writes better: merge checks, lock, checkpoints, backups before merges.
- John's side controls runs better: kill switch, deadline, strikes, holds, a global lock. It also recovers better: full git history every five minutes against the app's saturated 2,048-file history.
- John's side lacks a model timeout. The app's #29 check is inert on the CLI provider (5.3).

## 8. Recommendations, ordered by value

Each item names what moves, from which system, to which. All are within John's ask (what each system should take from the other), except where marked.

1. **App takes John's index-freshness discipline: re-index after every write and nightly, with a coverage check.**
   - **What John's side does:** `qmd update` and `qmd embed` after every sweep (`sweep.sh:1346-1351`), plus a nightly embed job.
   - **The app gap:** 1,627 pages are under old vector ids and 280 have none (5.2). Merges, hub rebuilds, lint fixes and other writers never re-embed (grep for `embedPage` callers). Merged-away pages leave vectors behind.
   - **Concretely:**
     - (a) run one forced re-index of the vault before #20's consolidation;
     - (b) make the scheduled maintenance tick count pages against vectors and re-embed the missing or stale ones;
     - (c) re-embed after a duplicate merge or hub rebuild.
   - (a) is procedural and gates #20's proof. (b) and (c) are code.
2. **App takes John's whole-vault snapshot before bulk change.**
   - **What John's side does:** git-commits the vault every 300 s (`vault:setup/autocommit.sh:19-32`).
   - **The app gap:** the app's history is capped and saturated, and the vault is not under its own git (5.8).
   - Before #20's one-off consolidation, take a dated full copy of `exp:wiki/`. Longer term, give the vault the same autocommit.
3. **App takes John's per-source ledger as a per-ingest run record.**
   - **What John's side does:** records status, attempts and reasons per source (`ledger.py`).
   - **The app should:** append one record per ingest: candidates offered, candidates updated, pages created, skips, failure reason. `maintenance-runs.jsonl` is the model to follow.
   - **Why:** without it, nobody can tell whether #17 is working beyond the counts in `log.md`.
4. **John's pipeline takes the app's scheduled duplicate scan and guarded merge (#18, #24, #29).**
   - **What the app does:** embedding prefilter at 0.68, model judge with confidence levels, high-confidence auto-merge only, not-duplicates list, backups before writing, reply rejection, run records (`dedup-runner.ts`, `scheduled-maintenance.ts`).
   - **The John-side gap:** it has no post-creation duplicate handling at all, and the #2278 spec plans only a one-off merge.
   - Make the session-memory merge pass recurring, on the night job, using this design. qmd's nightly vectors already exist (4.3).
5. **John's pipeline takes the app's meaning-based candidate search (#17) for AHR #2281.**
   - **What the app does:** offers existing pages per topic by vector search before generation, with a per-topic cap and a page budget (`ingest.ts:70-83`, `:2890-2967`).
   - **What John's side should do:** add a vector arm to `topic_lookup.sh` beside its BM25 and EXACT arms, reading qmd's existing vectors if a read-only query exists (open question 1). That would avoid building a separate store first.
6. **Both take the "model chooses, script verifies" check from AHR #2281's spec.**
   - After generation, refuse or flag any new concept or entity page whose title and summary score above a threshold against an existing page. Neither side has this.
   - The app can build it first: it has embeddings in process, and #17's search to reuse.
   - Calibrate the threshold on labelled pairs. #1918's 0.82 is not the app's effective 0.68.
7. **App takes John's lexical arm and EXACT disk test into candidate finding.**
   - **What John's side does:** pairs an exact disk test with keyword search (`topic_lookup.sh:64-98`).
   - **The app gap:** its candidate finder is vector-only, while its own Rust hybrid search (keyword plus vector, rank-fused) serves chat and the UI (`search.rs:327-539`) but not ingest.
   - Using the hybrid search for candidates would catch name matches the vector misses, and would also cover bare-id pages (`search.rs:414-417`).
8. **App takes John's script-owned, uncapped, categorised index.**
   - **What John's side does:** keeps the model out of the index and inserts sorted, counted entries by script with no cap (`index_insert.sh`).
   - **The app:** already has the equivalent in Rust (`project_maintenance.rs:287-354`) behind a manual button.
   - Run it from the maintenance tick so `wiki/index.md` lists every page again. The model no longer needs the index for candidates (#17); humans, deep research (`deep-research.ts:576-607`) and the review stage still read it.
9. **John's pipeline takes the app's hub rebuild (#19).**
   - **What the app does:** rebuilds named hub pages from vector-searched source summaries, under a lock with backup and shrink checks (`hub-rebuild.ts`).
   - **Why John's side needs it:** #1918 names the loss of gathering pages as the cost of dropping the concept layer. This gives session-memory those pages without minting one per session.
10. **John's pipeline takes the app's structural lint, in code and on a schedule.**
    - **What the app does:** resolves links by path slug and file name and reports orphans and dead links deterministically (`lint-structural-core.ts:102-224`).
    - **The John-side gap:** `/wiki-health` mis-resolves links and is never scheduled.
    - Add a duplicate-title rule that neither side's lint has. This is the natural first piece of AHR #58's `wiki-lint`.
11. **John's pipeline takes the app's structured write path for generation output.** SUGGESTED – not in original scope.
    - **What the app does:** parses FILE blocks and merges them in code, so identity fields and source lists cannot be lost (`page-merge.ts:111-115`, `:193-204`).
    - **The John-side gap:** its model writes with `bypassPermissions` and its write fence is prompt text only (`sweep.sh:688-694`; `prompts/generation.md:14-18`).
    - This trades away John's surgical edits, so it is a design choice, not a clear gain.
12. **App takes content-hash source identity from the Shared-Tools inbox pipeline.** SUGGESTED – not in original scope.
    - **What the inbox pipeline does:** keys sources by SHA-256 of content (`pipeline.py:71-80`).
    - **The app gap:** it keys by path, so `name (2).md` from Send-To-AH-Wiki or a clip-server suffix is a new source and a full re-ingest (`source-identity.ts:8-24`).

## 9. Defects found along the way

SUGGESTED – not in original scope. Ordered by how directly they affect #14's fixes and the #20 live proof.

**App, affecting #20:**
- **Duplicate merges leave folder-prefixed links and index lines dangling.** The rewrite regex needs `[[` immediately before the bare slug (`dedup.ts:500-505`, `:591`), and the app writes index lines as `[[entities/slug]]` (`ingest.ts:1764`). There are 1,437 such links in the vault. No test covers the form.
- **The #29 cut-off check cannot fire on the vault's provider.** The CLI transport never reports truncation (`claude-cli-transport.ts:196-209`, `:313`). On John's settings, only the 70% shrink check guards a cut-off merge. ESTATE.md does not say so.
- **The hub rebuild has no cut-off or cancel check** (`hub-rebuild.ts:68`).
- **The ingest page merger has no cut-off or cancel check** (`ingest.ts:3533-3560`, `:2230-2243`).
- **The duplicate scan reads entities and concepts only** (`dedup-runner.ts:167`). Findings (1,711 pages, 99.8% single-source) are never scanned.
- **The scan cannot address same-named pages in two folders.** It identifies pages by bare slug, last match wins (`dedup.ts:140`, `scheduled-maintenance.ts:257-260`). That covers the 4 vault cases in section 3.
- **Merged-away pages leave vectors behind.** They are deleted with `deleteFile`, which the watcher ignores as an app write, so the vector cleanup never runs (`dedup-runner.ts:481-489`; `fs.rs:1737-1749`; `file_sync.rs:472-475`). Inferred from code.
- **The ingest cache stops the 319 existing sources from growing pages** after #17 installs (`ingest.ts:844-848`).

**App, other:**
- **Duplicate review items cannot be merged,** and "Create Page" adds another page (5.4).
- **The overview prompt label is false;** the overview is never maintained (5.3).
- **Scheduled import on the vault is configured on a path the code always refuses** (5.8).
- **The chunker joins paragraphs with no separator** (`text-chunker.ts:530`).
- **Save to Wiki feeds its own page back into ingest** (5.8).
- **The project-lock comment overstates which writers take the lock** (5.8).
- **The run record is written but never shown in the UI** (5.5).

**John's side:**
- **The citation hook fails on every ingest write and would not block anyway** (4.2).
- **The sweep has no timeout on `claude -p`** (4.2).
- **The night job covers only st-peters,** which is fully ingested; five andrew-pain transcript records have been stuck in progress since August (4.2).
- **The inbox pipeline's output has no consumer,** and its converters have no timeout (`pipeline.py:96-101`).
- **The Miniflux FATAL path writes no per-run log** (`miniflux-poll.py:260-263` against `:336-341`). MINIFLUX.md says the job is loaded when it is not.
- **The archiver README says installed patches are not installed** (`archiver/README.md:172`; the installed hash matches `:450`).
- **The nightly qmd job hides embed failures behind `tail`** (4.3).
- **keppi has regrown to 51.6 GB** against the schema's ban (4.3).
- **`topic_lookup.sh` would fail for `matt-pocock` and `bb-consultants`,** which have no qmd collection (4.3).
- **The image sweep never settles** while 4 images fail permanently: 13 of 13 runs swept (`~/Library/Logs/wiki-ingest/experiment-images.log`). Its rewrites probably re-queue app ingest of the same clip (`file_sync.rs:780`, `project-file-sync.ts:348`; inferred from code).

## 10. Open questions

1. **Can qmd answer a vector query without writing its cache?** `topic_lookup.sh:15-16` avoids `qmd query` for that reason. `qmd vsearch` was not tested. This decides whether recommendation 5 can reuse qmd's existing vectors or needs #2279's separate store.
2. **Does `--allowedTools` under `--permission-mode bypassPermissions` remove the unlisted tools?** If not, phase 1 can write. This is read from documentation knowledge, not tested.
3. **Does a PostToolUse hook exit code ever block a write in this Claude Code version?** It matters only if the citation hook path is repaired.
4. **Does the app's `claude -p --setting-sources project`, run in `exp:`, load AHR's `CLAUDE.md` or `.claude/` into each ingest call?** The vault sits inside the AHR repository, so it could.
5. **Should #20 run the forced re-index (recommendation 1a) and the vault snapshot (recommendation 2) before the consolidation?** Both are procedural with one sensible path, so they are for the PM seat to schedule on #20, not a John decision.

## Appendix A. Commands run by this lane (first-hand)

Key output is shown after each arrow.

**Tickets and history**
- `gh issue view 15|14 --repo pearson-tfl/llm_wiki --comments > /tmp/llmw15/i1{5,4}.txt` and `--json title,body` → read in full.
- `git log --format='%h %ci %s' --first-parent estate | head -25` → `dba7169 2026-10-05 14:13:57`, …, `ca91343 2026-10-05 11:06:20` (#17), `b2e82d5 2026-10-04 15:23:30` (upstream 0.6.12).

**Installed build**
- `defaults read "/Applications/LLM Wiki.app/Contents/Info" CFBundleShortVersionString` → `0.6.12`.
- `ls -la "/Applications/LLM Wiki.app/Contents/MacOS/"` → `llm-wiki` dated `Oct 4 15:31`.
- `git log --format='%h %ci' --before='2026-10-04 15:31' -1 estate` → `b2e82d5 2026-10-04 15:23:30`.

**A2. Vector-store coverage** (read-only Python, `lancedb` over `exp:.llm-wiki/lancedb`, table `wiki_chunks_v2`)
- → `rows 21457 distinct 5514 qualified 3888 legacy 1626`
- → `content pages 5795 qualified-hit 3888 legacy-only 1627 none 280`
- → `sources 319 qualified 124`
- → `concepts 1356 qualified 798`, `entities 1058 qualified 669`, `findings 1711 qualified 1530`.

**Code re-checks**
- `sed -n 2936,2948p src/lib/ingest.ts` → `const relativePath = \`wiki/${hit.id}.md\``.
- `grep -n 'hit.id' src/lib/hub-rebuild.ts` → `209: const path = \`wiki/${hit.id}.md\``.
- `sed -n 500,508p src/lib/dedup.ts` → the regex is built from `\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`.
- `sed -n 161,168p src/lib/dedup-runner.ts` → `for (const prefix of ["wiki/entities", "wiki/concepts"])`.
- `sed -n 196,210p src/lib/claude-cli-transport.ts` → a comment saying sampling knobs, `max_tokens` included, are not wired through the CLI.
- `grep -n onDone src/lib/claude-cli-transport.ts` → `253: finishWith(onDone)`, `313: finishWith(onDone)`.
- `grep -n 'buildDedupLlmCall\|completeReplyOnly' src/lib/hub-rebuild.ts src/lib/dedup-runner.ts` → hub `:68` without the option; merge `:452` with `{ completeReplyOnly: true }`.
- `sed -n 479,489p src/lib/dedup-runner.ts` → `await deleteFile(\`${pp}/${dead}\`)`.
- `grep -n 'intervalHours\|enabled: true' src/lib/project-store.ts` → `371: enabled: true`, `372: intervalHours: 24`.
- `sed -n 100,121p src/lib/review-create-page.ts` → stable name, else a timestamped name, else numbered.

**Vault re-checks**
- `comm -12 <(ls exp:wiki/concepts|sort) <(ls exp:wiki/entities|sort)` → `agent-skills.md`, `openclaw-code-mode.md`, `openclaw-dreaming.md`.
- `find exp:wiki -name 'openclaw-sandbox-backends*'` → `comparisons/` and `entities/`.

**John's side re-checks**
- `sed -n 686,695p sweep.sh` → `--allowedTools "$@" --permission-mode bypassPermissions --model "$INGEST_MODEL"`.
- `sed -n 780,783p; 827,830p sweep.sh` → phase 1 `Read Bash`; phase 2 `Read Write Edit Bash`.
- `sed -n 70,75p topic_lookup.sh` → `"$QMD_BIN" search -c "$domain" --all --files -- "$topic"`.
- `find ~/.claude-ingest/projects -name '*.jsonl' | wc -l` → `407`.
- `xargs grep -ho 'check-wiki-citations.sh: No such file or directory' | wc -l` → `2280`.
- `grep -n command vault:.claude/settings.local.json` → `21: "command": ".claude/scripts/check-wiki-citations.sh"`.

## Appendix B. Commands run by sub-agents (cited above; output as they reported it)

**launchd** (`launchctl list | grep -i -E 'wiki|jeptech|inbox|qmd|archiver'`, then `launchctl print gui/501/<label>`)

| Label | Reported state |
|---|---|
| `com.jeptech.wiki-ingest-night` | `runs = 2`, exit 0, Hour 2, arguments `--batch --domain st-peters` |
| `com.jeptech.wiki-experiment-images` | `runs = 6` |
| `com.jeptech.jepaiwiki.autocommit` | `runs = 564`, 300 s |
| `com.jeptech.inbox-pipeline` | `runs = 2` |
| `com.user.session-memory-archiver` | 1800 s, `runs = 73` |
| `com.jeptech.qmd-nightly-embed` | `runs = 1` |
| `com.jeptech.wiki-ingest-day` | `Could not find service` |
| `com.jeptech.wiki-ingest-miniflux` | `Bad request.` |

**Ledger and logs**
- Ledger tally (`/tmp/llmw15/ledger_stats.py`) → as in 4.2.
- `ls ~/Library/Logs/wiki-ingest/sweep-*.log | wc -l` → `1227`; `du -sh` → `21M`.
- `tail -5 launchd-night.out` → `ingested 0 … skipped 96 (… already-terminal 96 …)`.
- Tool-use classifier over the ingest transcripts → `bash:topic_lookup 643`, `bash:fs-read 739`, `bash:index_insert 206`, `read:index.md 2`.

**Measurement scripts**
- `/tmp/llmw15/vault_stats.py`, `run_app_dist.sh` and `run_john_dist.sh` → the section 3 table.
- `near_dups.py`, `jaccard.py` and `near_dups_john.py` → the section 3 slug checks.
- `/tmp/llmw15/probe.py` → John's broken-link and orphan figures and `VibeCoding`.

**App state and the vault**
- app-state reads with provider, model and schedule fields only → `ingestPresetId = claude-code-cli`, `localCliIsolation = True`, `maxContextSize = 1000000`, `embeddingConfig.model = qwen3-embedding:0.6b`, `scheduledImportConfig … enabled true, path …/raw/sources, lastScan null`.
- `review.json` tally → `1714`; `('duplicate', False) 87`; resolutions `auto-resolved 245`, `llm-judged 1`.
- `ls exp:.llm-wiki/history | wc -l` → `2048`.
- `ls exp:.llm-wiki/page-history` → 22 backups.
- `grep -rhoE "\[\[[^]|]+" exp:wiki | wc -l` → `28895`; with `/` → `1437`.
- `wc -c exp:wiki/{purpose,schema,index,overview,log}.md` → 816, 3,340, 31,885, 210, 307,124.
- `git ls-files Agent-Harness-Wiki-Experiment | wc -l` (in AHR) → `11`.

**John's tooling**
- `qmd collection list` → 14 collections, no `matt-pocock` or `bb-consultants`.
- `qmd status` → 9.2 GB, 42,852 files, 1,661,210 vectors.
- `stat ~/.keppi/graphs/*.db` → `1e2b8cc83592.db`, born 3 Oct 20:31, 51,641,872,384 bytes.
- `df -h ~` → 88%.
- `grep -rn 'enrich-wikilinks|enrichWithWikilinks' src src-tauri mcp-server`, at head and with `git grep` at `b2e82d5` → test-helper comments only.
- `git show 82561c8` → removes the `enrichWithWikilinks(...)` call.

**AHR session-memory**
- `gh issue view {1918,2278,2281,58,2279..2285,57,44} --repo pearson-tfl/Agent-Harness-Reconfig` → all open except #57, closed 26 Sep.
- `git -C AHR log --all | grep -E '#(1918|2278|2281|58)\b'` → spec and grill commits only; merge `0639355f` on 26 Sep.
- `find …/session-memory/… -name '*.md' | wc -l` → transcripts 31,341; concepts 4,327; entities 2,879; sources 2,509.
