# Estate fork of LLM Wiki

John's own build of LLM Wiki. Fork: `pearson-tfl/llm_wiki`. Upstream:
`nashsu/llm_wiki`. Ticket: pearson-tfl/Agent-Harness-Reconfig#1879.

## Layout

- Clone: `/Users/johnp/Code/llm_wiki`. Remote `origin` is the fork; remote
  `upstream` is nashsu.
- `main` – exact mirror of upstream. Never commit to it.
- `estate` – upstream release plus John's changes. The installed app is built
  from this branch.
- `/Applications/LLM Wiki.app` – the installed estate build.

## John's changes on `estate`

Keep this list current. Merge conflicts can only come from these files.

- `vite.config.ts` – version stamp. Settings > About shows
  `v<release>+estate.<commit>`, e.g. `v0.6.11+estate.e808211`, naming the
  exact commit the app was built from. No manual bump needed. `-dirty` on the
  end means the build had uncommitted edits; no commit at all means it was
  built outside a git checkout. Finder's Get Info still shows the plain
  release: the bundle version comes from `src-tauri/tauri.conf.json`, which
  changes every upstream release, so stamping it would conflict every merge.
- `src/lib/update-check.test.ts` – one test: the stamp does not confuse the
  update check.
- `src-tauri/src/commands/claude_cli.rs` – the Claude Code provider starts
  `claude` with `CLAUDE_CONFIG_DIR=~/.claude` unless the app's environment
  already names one, so it reads `~/.claude/.claude.json`, not
  `~/.claude.json`: the account it signs in with, and also the user-level MCP
  servers it loads. Tests in the same file. Opening the app from a terminal
  that exports another `CLAUDE_CONFIG_DIR` puts it on that account, with no
  error; open it from the Dock.
- `src/lib/claude-cli-transport.ts`,
  `src/components/settings/sections/llm-provider-section.tsx` – the app's
  sign-in hints say `CLAUDE_CONFIG_DIR=~/.claude claude`, not bare `claude`,
  which would sign in the other account.
- `src/lib/__tests__/claude-cli-transport.test.ts` – the two hint tests
  expect that command.
- `src-tauri/src/agent/runtime.rs`, `src-tauri/src/agent/context.rs` – with
  the Claude Code or Codex CLI provider, pages attached with @ reach the
  model: the chat turn's retrieval answer carries their text, in the same
  form the HTTP providers get. Upstream sends it only to HTTP providers.
  `context.rs` moves that formatting into its own function,
  `render_explicit_files`, unchanged. Tests in `runtime.rs`. HTTP API / MCP
  callers on a CLI provider that pass attached files get their text in the
  reply too, when the search finds a page; with no hits they get upstream's
  "not configured" error.

  History: until v0.6.12, `runtime.rs` also carried upstream PR
  nashsu/llm_wiki#727, so that a CLI chat question matching no wiki page did
  not fail before `claude` started. v0.6.12 fixes that itself (upstream
  commit ba39c7c: the chat panel sets a preflight flag), #727 was closed
  unmerged, and the estate runs upstream's fix.
- `src/components/layout/activity-panel.tsx`, `src/i18n/{en,it,ru,zh}.json` –
  a "Clear finished from queue" link at the bottom of the activity panel,
  under "Clear completed". It removes done, failed and cancelled items from
  the ingest queue; upstream has the function (`clearCompletedTasks`) but no
  button for it, so a cancelled item could not be removed. Test in
  `src/lib/ingest-queue.test.ts`.
- `src/main.tsx`, `src/lib/external-links.ts` – web links (http, https,
  mailto) open in the system browser instead of taking over the app window,
  which has no back button (pearson-tfl/llm_wiki#1). One click listener on
  the whole document, so it covers the page reader, the file preview, the
  research panel and any link added later; wiki links, in-page anchors and
  relative paths are left to the app. Upstream routes only some links
  (frontmatter, About) through the opener. A protocol-relative link
  (`//host/x`) is a web link too, opened as https. A path link
  (`../x.md`) that no component handled is stopped, so the window stays
  (pearson-tfl/llm_wiki#8). Not covered: links inside an HTML file's
  preview frame, and middle-clicks, are not seen by the listener. Tests in
  `src/lib/external-links.test.ts`.
- `src/components/editor/wiki-reader.tsx`, `src/lib/relative-links.ts`,
  `src/i18n/{en,it,ru,zh}.json` – a path link in the page reader
  (`../x.md`, `./x.md`) opens the project file it names in the app's
  preview, resolved against the linking page's own folder, as the app
  already does for images; a path starting with `/` is read from the
  disk's root. When the project has no such file, an in-app notice names
  the link (pearson-tfl/llm_wiki#8). Not covered: in the file preview and
  the research panel, a path link is stopped with no notice. Tests in
  `src/lib/relative-links.test.ts`.
- `src/lib/ingest.ts` – ingest grows existing pages (pearson-tfl/llm_wiki#17,
  fix 1 of #16). The analysis ends with a topics list, and each long-source
  digest begins with one, so trimming a long digest keeps it. Before
  generation, ingest adds any page whose file name matches a topic's title,
  then searches the wiki once per topic with the app's hybrid search, by
  keyword and by meaning, with graph neighbours off (#70). Each search
  fetches 50 hits and keeps the best 3 that are pages ingest may offer and
  that exist with text, so the index, the log, other sources' summaries and
  hits with no page behind them do not use up a topic's places (#22). When
  the hybrid search fails, the remaining topics use the search by meaning
  alone, which fetches 10 hits; when only its meaning half fails, the
  keyword hits are kept. It gives generation up to 12 of
  those pages, with their exact paths and text, inside a block capped at 15%
  of the context. The cap is counted with the schema, purpose, index and
  overview in the room set aside before the source budget is worked out, so
  a source that would not fit beside them goes to the chunked path. Upstream
  limits that room to a quarter of the context, so the whole cap is reserved
  only while those four files take a tenth of the context or less. Their
  size does not shrink with the context, so the smaller the context, the
  more likely only part of the cap is reserved. The prompt tells the model to
  update a listed page by its exact path. The index is labelled a partial,
  read-only list of recent pages and the overview read-only. Each ingest's
  `wiki/log.md` entry ends with pages offered, updated and created, and why
  the search or the exact-path check was skipped or fell back when one was,
  including a failed embedding fetch or vector store search. `ingest.ts` is
  a large upstream file that changes in most releases: re-check these
  changes at the next upstream merge. Tests in
  `src/lib/ingest-candidates.test.ts` and `src/lib/ingest.prompt.test.ts`.
  `src/lib/ingest-source-path-collision.test.ts` had its merge fake matched to
  the real merge prompt.
- `src/lib/ingest.ts`, `src/lib/page-merge.ts`, `src/lib/ingest-cache.ts`,
  `src/lib/llm-task-routing.ts` – each ingest attempt appends one JSON line to
  `.llm-wiki/ingest-runs.jsonl` (pearson-tfl/llm_wiki#68), whether it was
  done, skipped as a cache hit, or failed, with the reason or error. The line
  carries start and finish times, the source as `wiki/log.md` names it, the
  ingest cache's SHA-256 of the source text, the ingest preset id and model,
  the analysis's topics, each existing page offered and whether an exact
  file-name match, the hybrid search or the embedding search found it
  (`exact-slug`, `hybrid-search`, `vector-search`; #70), why a check was
  skipped,
  the pages updated and created (the same counts as the log entry), and each
  merge that fell back because its model reply was rejected or the call
  failed, with why. A run that fails early has only the fields it reached.
  Writes go one at a time, and a write that fails is logged, never failing
  the ingest. `page-merge.ts` gains an optional fall-back callback,
  `ingest-cache.ts` exports its hash and `llm-task-routing.ts` gains
  `getIngestLlmPresetId`. No screen shows the file yet. Tests in
  `src/lib/ingest-run-record.test.ts` and `src/lib/llm-task-routing.test.ts`.
- `src/lib/ingest.ts`, `src/lib/dedup-runner.ts`, with the new
  `src/lib/new-page-check.ts` – after an ingest's writes, each concept or
  entity page it created is compared with the existing concept and entity
  pages (pearson-tfl/llm_wiki#69), and with the other concept and entity
  pages the same ingest created, which are not yet in the embedding store
  (pearson-tfl/llm_wiki#75). The score is the cosine of the two pages'
  summary embeddings, the text the duplicate scan embeds (`dedup-runner.ts`
  now exports `summaryToEmbeddingPage` for it); candidates come from the
  embedding search, and a hit stored under a bare slug is mapped to the
  concept or entity file of that name. A page scoring 0.89 or more is
  flagged, never refused: a line in `wiki/log.md` names both pages and the
  score, the run record's `newPageCheck` lists it, and a duplicate review
  item opens either page. Every ingest's log entry says how many new pages
  were checked and flagged. Embeddings off, a failed embedding call or a
  vector-store error skips the check with a log line; the ingest carries on.
  A cancelled ingest skips the check and makes no embedding call for it
  (pearson-tfl/llm_wiki#75).
  Tests in `src/lib/ingest-new-page-check.test.ts`; opt-in runs on a real
  endpoint in `src/lib/ingest-new-page-check.real-llm.test.ts` and
  `src/lib/new-page-check.calibration.real-llm.test.ts`.

  The threshold was calibrated on 6 Oct 2026 with the calibration run on 35
  page pairs from the Agent Harness Wiki, labelled by reading both pages,
  with Ollama `qwen3-embedding:0.6b`. Twins (10): pages on one subject, such
  as `claude-3-7-sonnet` and `claude-sonnet-3-7`, plural pairs such as
  `openclaw-secretref` and `openclaw-secretrefs`, and the three slugs that
  are both a concept and an entity. Distinct (25): pages whose names share
  words, such as `gpt-4-1` and `gpt-4-1-mini`, including four the
  near-duplicate scan listed as twins that name different things
  (`todo-write` is DeepSeek harness's tool, `todowrite` Claude Code's;
  `openclaw agent` and `openclaw agents`; the `agent.wait` RPC and the
  `agents_wait` tool; `openclaw node` and `openclaw nodes`). No past scan
  merge was on disk to add.

  | Threshold | Twins flagged | Distinct flagged | Precision | Recall |
  |---|---|---|---|---|
  | 0.68 (the scan's prefilter) | 10/10 | 25/25 | 0.29 | 1.00 |
  | 0.82 (AHR #1918's figure) | 9/10 | 8/25 | 0.53 | 0.90 |
  | **0.89 (chosen)** | 9/10 | 3/25 | 0.75 | 0.90 |
  | 0.91 | 8/10 | 1/25 | 0.89 | 0.80 |
  | 0.92 | 5/10 | 0/25 | 1.00 | 0.50 |

  A flag loses nothing, so recall is preferred to precision. Twins scored
  0.818 to 0.952 and distinct pairs 0.685 to 0.910, so the two ranges
  overlap and no value separates them: re-run the calibration if the
  embedding model changes.
- `src/lib/scheduled-maintenance.ts`, `src/lib/project-store.ts`,
  `src/lib/dedup-queue.ts`, `src/lib/dedup-storage.ts`, `src/lib/dedup.ts`,
  `src/lib/dedup-runner.ts`, `src/lib/page-merge.ts`,
  `src/lib/ingest-queue.ts`, `src/App.tsx`, `src/lib/auto-save.ts`,
  `src/components/settings/sections/maintenance-section.tsx`,
  `src/components/review/review-view.tsx`,
  `src/i18n/{en,it,ru,zh}.json` – a scheduled
  maintenance job per wiki project runs the duplicate scan with no click
  (pearson-tfl/llm_wiki#18, from #16). On by default, every 24 hours,
  switchable and adjustable in Settings > Maintenance; the setting sits in
  `app-state.json` beside the scheduled import one. A timer checks every
  10 minutes for the open project only, and an overdue run starts when the
  wiki is opened. A run waits, and records why, while the ingest queue is
  busy, a previous run is still going, or no model is set. High-confidence
  groups go onto the existing merge queue, into the page with the most
  sources, then the earliest created date, then the first listed; a group
  holding a pair marked "not duplicates" is never merged, and a
  not-duplicates list that cannot be read merges nothing. Before each
  merge the run re-reads the ingest queue and the switch, and stops
  merging if either changed during the scan; that run stays due. The
  queue runs those merges with no resume click, after a restart too;
  hand-queued merges restored from disk still wait for it. Every group not
  queued for a merge is saved to `.llm-wiki/dedup-pending-groups.json`,
  which the Maintenance screen shows on open. After merges the review sweep closes stale duplicate items.
  Each run appends a line to `.llm-wiki/maintenance-runs.jsonl`.
  Ingest and a duplicate merge never write at once (#24): the merge queue
  starts no merge while ingest is active – a source processing, or pending
  in a queue that is neither paused nor waiting on model settings
  (`isIngestActive`, the only change #24 made to `ingest-queue.ts`) – and checks
  again every 5 seconds, so it carries on with no click; a running merge
  holds the project write lock every ingest write takes, from its first
  read to its last write. A merge reply that is empty, has no readable
  frontmatter, keeps under 70% of the longest page's body (the
  threshold `page-merge.ts` uses, shared from there), or that the model
  client reports cut off at its output limit (#29, in `dedup-runner.ts`;
  which routes report it: the Claude Code CLI entry below, #32) is
  rejected before any write, by hand-queued and
  scheduled merges alike: no page changes, none is deleted, the task
  stays failed with the reason, a duplicate item goes to the review
  queue, and the run record counts it in `mergesRejected` with the group
  and reason in `rejectedMerges`. A rejected merge is not retried within
  the run, but the next scheduled scan (daily by default) queues the
  group again if it still finds it with high confidence, which resets the
  failed task. A merge cancelled or cut short by a project switch while
  the model replies writes nothing (#29): the client ends a cancelled
  request as done with the text so far, so the merge checks its cancel
  signal before the reply. A cancel starts the next merge at once; the
  cancelled merge's run, when it ends, leaves the queue alone and files
  no review item, so the next merge can still be cancelled and no third
  starts beside it (#33). A merge starts only if, once the queue has
  looked its project up in the registry, it is still queued and pending
  and no other merge has started; a project switch stops the old
  project's queue before saving it, so no merge starts on the old
  project during the switch (#35). Project switches can overlap, so the
  dedup queue runs its pauses and restores one at a time, mostly in the
  order they were called (a call arriving between two steps can go
  first): a restore reads a project's queue file only once the save
  before it has landed, and a pause's clean-up never empties the next
  project's queue (#39). A pause or restore still running after 30
  seconds fails alone with a logged `SwitchStepTimeoutError`, leaves no
  project's merge queue open, and lets the steps behind it run; its read
  or write settling later changes nothing in memory. A restore first
  stops the open project's merge and saves its queue, and `App.tsx`
  skips the restore, before it is called and again once its turn comes,
  when another project has been opened since (#43). A queue save that
  lands after a newer save to the same file is overwritten again with
  the newer one, so a finished merge does not come back as pending. A
  restore cut off at 30 seconds while its project is still the one
  opening files a review item whose Retry, on the Review screen, opens
  the project's merge queue again. A merge run whose last save lands
  after a project switch leaves the "a merge is running" flag and the
  ingest wait to the project now open (#48). A restore cut off after the
  user has opened another project files no review item, so a Retry on the
  screen always belongs to the project open. A Retry that waits behind
  another restore does nothing if that restore opened the queue; if that
  restore was cut off too, the notice it filed stays, and its own Retry
  runs it. A Retry dismisses the notice only once no restore is left cut
  off (#52). A restore that opens a project's merge queue dismisses it
  too, and so does project open when the review items it loads hold a
  notice saved before that queue opened (#59). Project open turns
  auto-save back on before it reads the project's saved review items, so
  the review auto-save writes nothing for a project until they have
  loaded, and the load keeps a notice filed meanwhile beside them (#62).
  An item that arrives during that load and matches a saved one is merged
  with it, so a resolved item stays resolved, except a time-out notice,
  which a restore files open on purpose; arrivals reach an empty saved
  file at once; and the review auto-save opens for the project even if
  the merge-queue module fails to import, since project open's review
  load (now in `auto-save.ts`) imports it first, in its own catch (#65).
  Upstream edits to the dedup queue, the dedup merge, the ingest queue,
  the Maintenance screen, the Review screen, the auto-save or project
  open in `App.tsx` need re-checking against this.
  Tests in `src/lib/scheduled-maintenance.test.ts`,
  `src/lib/auto-save.test.ts`, `src/lib/auto-save.review-load.test.ts`,
  `src/lib/auto-save.review-load-import.test.ts`,
  `src/lib/dedup-queue.test.ts`, `src/lib/merge-ingest-safety.test.ts`,
  `src/lib/dedup-runner.test.ts`, `src/lib/dedup.test.ts` and
  `src/lib/ingest-queue.test.ts`.
- `src/lib/claude-cli-transport.ts`, `src/lib/dedup.ts`,
  `src/lib/dedup-runner.ts`, `src/lib/hub-rebuild.ts`, `src/lib/ingest.ts`
  – a reply cut off at the model's output limit is caught on the Claude
  Code CLI route (pearson-tfl/llm_wiki#32). The CLI asks for its own
  output cap (128,000 tokens on `claude-opus-5-5`) and ignores the one the
  app asks for. At that
  limit it does not end the reply: it adds a user turn of its own ("Output
  token limit hit. Resume directly …") and resumes, up to three times. The
  transport matches that wording as Claude Code 2.1.289 writes it. With
  local CLI isolation on, the CLI has no tools and takes a second turn only
  to resume, so the transport also flags a user turn the CLI marks
  synthetic, or a `result` event counting more than one turn, whatever the
  wording (#37). Isolation is off by default; with it off the wording is
  the only signal, so re-check it when the CLI updates, since a reworded
  turn would go unflagged there. The transport flags a reply during which
  the CLI hit its limit and resumed as cut off, even when a resume
  finished it, since the join between the turns is
  unchecked, and passes on the CLI's stop reason (`stop_reason` on the
  `result` event, `end_turn` on a normal reply). A reply whose resumes
  ran out ends in a CLI error, as before. Which routes catch a cut-off
  reply: the HTTP providers, from the finish reason; the Claude Code CLI,
  as above; not the Codex CLI. Codex's output carries no finish reason,
  and it ignores an output cap set from the app's side; the Codex binary
  turns a reply the model cut short into a stream error, so such a reply
  would reach the app as an error, not as a reply. That is read from the
  binary; no live run has shown it. Every caller that reads the flag sees
  it on the Claude Code route too: the duplicate merge and the hub
  rebuild reject the reply, and ingest and deep research treat it as they
  do on HTTP; the merge, hub and ingest messages name no cap, since the CLI
  routes never receive one. A reply with no finish reason is still taken
  as complete, because the Codex route never sends one. Tests in
  `src/lib/__tests__/claude-cli-transport.test.ts`, replaying stdout
  recorded from the live CLI in `src/lib/__tests__/fixtures/claude-cli/`,
  and in `src/lib/scheduled-maintenance.test.ts`.
- `src-tauri/src/commands/claude_cli.rs`, `src/lib/claude-cli-transport.ts`
  – on the Claude Code CLI route, a call with chat history gets one reply
  that reads the history (pearson-tfl/llm_wiki#46). Claude Code 2.1.289
  answers every piped user message as a query of its own and ignores piped
  assistant turns, so the chat panel, editor selection follow-ups and the
  interactive ingest write-out got every earlier question answered again,
  joined in front of the reply. The app now sends the CLI one user turn:
  the system text, then the earlier turns as a transcript tagged `<user>`
  and `<assistant>`, then the latest message; an image in an earlier turn
  keeps its place. Upstream pipes each turn separately. The stream parser
  also starts afresh on each new query, result or message, so a reply that
  begins with the previous reply's text is no longer clipped. Tests in
  `claude_cli.rs` and `src/lib/__tests__/claude-cli-transport.test.ts`; the
  fixture `piped-history.jsonl` is the live CLI's reply to
  `piped-history.stdin.jsonl`, which a Rust test pins as the app's own
  stdin for that chat. A turn tag inside an earlier turn has its `<`
  written as `&lt;`, so message text cannot pass as another turn; two text
  blocks in one message are joined with a newline; a conversation ending
  on an assistant turn is refused with an error (#50). The escape also
  catches a spaced or attributed tag such as `</user >` or
  `<assistant id=1>`, and covers the system text, which can carry wiki or
  source text; an empty text block adds no newline (#54). Like the #32
  wording, re-check this when the CLI updates: run
  `scripts/estate/live-cli.sh` on `piped-history.stdin.jsonl`,
  `piped-history-forged-tags.stdin.jsonl` and
  `piped-history-spaced-tags.stdin.jsonl`, and confirm each gives one
  `success` result. A version whose prompt-injection guard refuses a
  transcript with `<assistant>` sections would turn every chat with history
  into an error.
- `src/lib/embedding.ts` – `searchByEmbedding` takes an option to throw when
  the vector store search fails, which ingest's candidate search uses when
  it falls back from the hybrid search, so the failure reaches its log (#22,
  #70), and the hub rebuild's search uses so the
  failure is that hub's reason (#27). Without the option it returns no hits,
  as upstream does.
- `src-tauri/src/commands/search.rs`, `src/lib/search.ts`,
  `src-tauri/src/agent/tools.rs`, `src-tauri/src/api_server.rs` – the
  hybrid search (`search_project`) takes `includeGraph`, which leaves out
  the graph-neighbour slots when false, and its response carries
  `vectorError` when the query embedding or the vector store search failed
  and only keyword hits came back (#70). Upstream only printed that to the
  console. Chat, the UI, the API and MCP keep the graph slots; the API and
  the agent's search tool do not pass `vectorError` on. `searchWikiMatches`
  in `search.ts` is ingest's caller. Tests in `search.rs` and
  `src/lib/ingest-candidates.test.ts`.
- `src/lib/hub-rebuild.ts`, `src/lib/scheduled-maintenance.ts`,
  `src/lib/page-merge.ts` – the scheduled maintenance job rebuilds hub pages
  from a one-off request file (pearson-tfl/llm_wiki#19, fix 3 of #16). After
  the duplicate scan, a due run reads `.llm-wiki/hub-rebuild-request.json`,
  `{"pages": ["wiki/concepts/<hub>.md", ...]}`, written by an agent. For each
  hub it searches by meaning on the hub's title and text (200 pages deep),
  takes the source summaries (`wiki/sources/`) found, within the page budget
  left after the hub, and has one model call rewrite the hub as a synthesis
  linking the summaries it draws on. The hub keeps its own front matter; its
  sources list gains the sources of each summary the rewrite links, and
  `updated` is stamped. The old page goes to
  `.llm-wiki/page-history/hub-rebuild-<time>/` before the write. A rewrite
  with no front matter, or whose body is under 0.7 of the old body (the
  same-path merge's ratio, now exported from `page-merge.ts` with its
  front-matter setter), or that the model client reports cut off at its
  output limit (#32), is rejected and the old page kept. Embeddings off, a
  failed search (the embedding fetch, or the vector store, named as
  `search failed: vector store: …`), no summaries found, a missing page, a
  page with no front matter or a path not under `wiki/` fail that hub with
  the reason, and the next hub runs. The request is then moved to
  `.llm-wiki/hub-rebuild-archive/<time>.json` with each hub's result. The
  run's line in `maintenance-runs.jsonl` lists the hubs rebuilt and rejected.
  Ingest activity (`isIngestActive`, as the merge queue reads it, so a paused
  queue's pending tasks do not hold the run back) and the switch are read at
  the run's start and re-read before each hub and before each write. The
  final read, backup and write of each hub hold the project write lock every
  ingest write and merge takes (#27), and the re-read before the write is made
  once the lock is held; a hub whose page changed on disk during its model
  call fails and is kept as it is. If ingest or the switch changed, the run
  stops with the request in place, stays due, and redoes on the next run any
  hub it had already rebuilt. An unreadable request is left in place and the
  run records why. Tests in `src/lib/scheduled-maintenance.test.ts`.
- `src/lib/embedding-freshness.ts`, `src/lib/embedding.ts`,
  `src/lib/ingest-cache.ts`, `src/lib/scheduled-maintenance.ts`,
  `src/lib/dedup-runner.ts`, `src/lib/hub-rebuild.ts`,
  `src-tauri/src/commands/vectorstore.rs`, `src-tauri/src/lib.rs` – the
  vector index is kept fresh (pearson-tfl/llm_wiki#67, from #15). Each
  scheduled maintenance run first backfills the vector store, before the
  duplicate scan. It lists the wiki's content pages (structural pages
  left out, as the Settings re-index does) and the store's page ids (new
  Rust command `vector_list_page_ids`). It then embeds up to 500 pages:
  first those with no vectors under their folder-qualified id (none at
  all, or only under the old bare slug, whose rows the embed then removes
  when one page owns the name), then those whose file changed since they
  were embedded. "Changed since embedded" is a content hash: every
  successful embed (`embedPage`, so ingest, deep research, merges, hubs and
  the backfill, and the Settings re-index) records the SHA-256 of the
  page's text in `.llm-wiki/embedded-pages.json` (written once per batch
  since #73, below), and a page whose hash is
  missing or differs is re-embedded. Pages embedded through the API/MCP
  route, which keeps its own revision record, are re-embedded once by the
  next backfill. A page with nothing to embed counts as covered. The run's
  line in `maintenance-runs.jsonl` carries `vectorCoverage`: pages,
  covered, embedded this run and failed (#73 adds `orphansRemoved` and
  `stoppedEarly`, below). A duplicate merge removes the merged-away pages'
  vectors before deleting their files; the canonical page and every page
  whose links it rewrote are then re-embedded (since #73, by the merge
  queue once the project lock is released, below); a hub rebuild
  re-embeds each rebuilt hub. A failed embed is logged, gets a line in
  `.llm-wiki/embedding-failures.jsonl` (time, trigger, page, reason) and
  never fails the merge, rebuild or run; the page keeps its old hash, so
  the next backfill tries it again. Tests in
  `src/lib/embedding-freshness.test.ts`,
  `src/lib/dedup-runner.reembed.test.ts`,
  `src/lib/scheduled-maintenance.test.ts` and the Rust
  `v2_list_page_ids_returns_each_page_once`; the in-memory store they
  share is `src/test-helpers/fake-vector-store.ts`.
- `src/lib/embedding-freshness.ts`, `src/lib/embedding.ts`,
  `src/lib/dedup-runner.ts`, `src/lib/dedup-queue.ts`, `src/lib/ingest.ts`
  – vector freshness follow-ups (pearson-tfl/llm_wiki#73, from the #67
  gate). A merge's re-embed of the canonical and rewritten pages runs in
  the merge queue after the project write lock is released, so an
  embedding endpoint that hangs no longer holds an ingest's write; the
  merged-away pages' vectors are still removed inside the lock. The
  backfill, after 5 failed embeds in a row, checks the endpoint with one
  request: if that fails too it stops, the run's `vectorCoverage` says why
  (`stoppedEarly`) and the rest wait for the next tick; if it answers, the
  pages themselves failed and the run carries on. Before embedding, the backfill removes the vectors of every
  stored page id that names no content page and whose file is gone
  (`orphansRemoved`), then, in one write, those ids' entries in
  `.llm-wiki/embedded-pages.json` (since #80, `removeEmbeddedHashes`),
  and in the same write, since #82, the entry of every recorded id with no
  vectors that names no content page and whose file is gone, such as one
  left by a delete before #80 or by a merge (whose
  `removeWikiPageEmbeddings` removes vectors only); an entry whose page's
  vectors are written again after its file check is kept (#82). A
  bare-slug id whose name a page still owns is kept, an id the Mac's
  case-insensitive lookup still finds keeps its vectors and its entry,
  and an empty listing removes nothing.
  `.llm-wiki/embedding-failures.jsonl` keeps its newest 1,000 lines.
  `.llm-wiki/embedded-pages.json` is written once per backfill run (twice
  when it removed entries of gone pages), merge re-embed, hub re-embed
  and ingest, not once per page (`embedPage`'s
  `hashes` option and the exported `recordEmbeddedHashes`). Each page's
  vector writes are numbered in the order they land, and a batch records
  a page's hash only if its own write is still the page's latest, so a
  merge re-embed and an ingest on the same page cannot leave old vectors
  under a current hash; the next backfill re-embeds such a page. The merge
  task is reported done and leaves the queue before its re-embed starts,
  so a cancel meanwhile finds nothing to cancel, and the next merge waits
  for the re-embed; since #80 an error in that re-embed is only logged,
  so it cannot bump the finished merge's retry count or report it failed
  after done, and since #82 the same holds for the re-embed after a
  cancel or project switch, whose error is no longer logged as the
  cancel. Tests in
  `src/lib/embedding-freshness.test.ts`,
  `src/lib/dedup-queue.reembed-error.test.ts`,
  `src/lib/dedup-runner.reembed.test.ts`,
  `src/lib/merge-ingest-safety.test.ts`, `src/lib/dedup-queue.test.ts`
  and `src/lib/ingest-embed-record.test.ts`; an opt-in run on a real
  embedding endpoint (a relay that holds the merged page's request, a
  stopped port, and the endpoint itself) in
  `src/lib/embedding-freshness.real-llm.test.ts`.
- `src/lib/ingest-queue.ts`, `src/lib/ingest-queue.integration.test.ts` –
  the test-only `clearQueueState()` cannot stop an ingest queue save that
  is already writing, so it hands back a promise that settles once that
  save has landed. The real-file tests await it before they write or read
  the queue file, so a late save no longer empties the file under a
  restore (pearson-tfl/llm_wiki#58). Production switches projects through
  `pauseQueue()`, which already waits for every save. Tests in
  `src/lib/ingest-queue.test.ts`.
- `scripts/estate/build.sh`, `scripts/estate/build.test.sh` – the build
  script and its tests (pearson-tfl/llm_wiki#84); see Build below. Upstream
  has no `scripts/estate/`, so they conflict only if it adds one.
- `scripts/estate/live-cli.sh`, `scripts/estate/live-cli.test.sh` – one
  live run of the installed `claude` as the app's Claude Code provider runs
  it (pearson-tfl/llm_wiki#92), for recording a fixture under
  `src/lib/__tests__/fixtures/claude-cli/` or live-proving a change to the
  CLI transport: `scripts/estate/live-cli.sh <stdin.jsonl> <output>`. It
  passes the flags `build_claude_cli_args("claude-opus-5-5", true)` builds,
  runs from a scratch folder it makes and removes, makes the output's
  folder, and prints the CLI version. It carries the lane fence on
  `--settings` as the lane launchers register it, so the session it starts
  is fenced like the lane that starts it, and the same command typed in a
  lane is not refused; with `--tools ""` the fence never fires. Re-check
  the flags here when `build_claude_cli_args` changes. Not part of the app.
- `scripts/estate/ext-rename/` – a one-off rename of the Agent Harness
  Wiki's 68 `learn-agent-arch-ext-*` sources to their titles
  (pearson-tfl/llm_wiki#3): the fixed old-to-new list, the script, its
  tests (`python3 -m unittest discover -s scripts/estate/ext-rename`), and
  `prove-on-copy.sh`, which runs the app's own startup comparison and
  change processing on a renamed copy of a vault. Not part of the app;
  upstream has no `scripts/estate/`.
- `ESTATE.md` – this file.
- `CONTEXT.md`, `CODING_STANDARDS.md`, `docs/adr/`, `docs/agents/` – the
  project files the `llm-wiki-pm` seat works from (AHR #2941): the domain
  glossary, a pointer to the estate's coding standards, the decision
  record and the tracker docs. Upstream has none of them today, so they
  conflict only if it adds a file of the same name. Upstream's
  `.gitignore` ignores `docs/`, so a new file there is added with
  `git add -f`; once tracked, it stays tracked.

`CLAUDE.md` is not on the list because it is not committed: it is a link to
the estate's project file, `config/projects/llm-wiki.md` in
Agent-Harness-Reconfig, kept out of git by `.git/info/exclude`.

## Build

Build only through the script, never by typing its steps:

```sh
/Users/johnp/Code/llm_wiki/scripts/estate/build.sh
```

It builds the checkout it lives in. It puts Rust (`~/.cargo/bin`) and protoc
(`/opt/homebrew/bin`) on PATH itself, since neither is on the agent PATH;
stops before building, naming the tool, if node, cargo or protoc is missing;
runs `npm ci` and `npx tauri build --bundles app`; and ends by printing the
commit it built (the value Settings > About will show) and the bundle path,
`src-tauri/target/release/bundle/macos/LLM Wiki.app`. Tests:
`scripts/estate/build.test.sh`.

Needs Node 20 or later (built here with 22), Rust and protoc, which
upstream's README lists (`brew install protobuf`). First build about 10
minutes, later builds faster. `--bundles app` skips the `.dmg`: making it
scripts Finder, which can raise a macOS permission dialog.

## Install

John's yes first; record it on the ticket.

1. Ask John to quit LLM Wiki, so it saves its state. Fallback only: `kill`
   its pid. Not `osascript`, which raises an Automation permission dialog.
2. Archive the old app and its data to
   `~/Room-101/<date>-llm-wiki-<old version>/`: the `.app`, plus
   `~/Library/{Application Support,Caches,WebKit}/com.llmwiki.app` under
   `data/`. Add the folder to Room 101's `.gitignore` and an `INDEX.md`
   entry; commit. Leave the data folders in place – the new build reuses them.
3. `ditto` the new `.app` to `/Applications/LLM Wiki.app`.
4. John opens it from the Dock or Finder. Not `open` from an agent's shell:
   the app inherits that session's environment, including its
   `CLAUDE_CONFIG_DIR`, and Claude Code chats then run on the agent's
   profile. Check Settings > About shows the new stamp and John's wikis load.
   John's settings live in `app-state.json` in the Application Support
   folder; compare its keys with the archived copy. Then John sends one chat
   message on the Claude Code provider and it answers.

## Taking an upstream release

The app's own update banner checks nashsu's releases. Treat it as the signal
to run this routine. Do not download the upstream `.dmg`: it replaces the
estate build with nashsu's.

```sh
cd /Users/johnp/Code/llm_wiki
git fetch upstream --tags
git diff --name-only main...estate        # files estate changed; compare with the list above
git switch main && git merge --ff-only vX.Y.Z && git push origin main
git switch estate && git merge vX.Y.Z     # conflicts only in the files above;
                                          # in vite.config.ts keep the estate stamp
npm ci && npm run typecheck && npm run test:mocks
(cd src-tauri && cargo test --lib -- claude_cli agent::runtime)
git push origin estate
```

In a fresh checkout or worktree, `cargo test` stops in the build script
until `mcp-server` is installed and built:
`npm --prefix mcp-server ci && npm run mcp:build`.

Then Build and Install as above. Record the release, the new commit and the
test result on the ticket.
