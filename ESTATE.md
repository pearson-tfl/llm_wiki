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
  generation, ingest searches the wiki by meaning once per topic and adds any
  page whose file name matches a topic's title. Each search fetches 10 hits
  and keeps the best 3 that are pages ingest may offer and that exist with
  text, so other sources' summaries and embeddings with no page behind them
  do not use up a topic's places (#22). It gives generation up to 12 of
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
  the embedding search or the exact-path check was skipped when one was,
  including a failed embedding fetch or vector store search. `ingest.ts` is
  a large upstream file that changes in most releases: re-check these
  changes at the next upstream merge. Tests in
  `src/lib/ingest-candidates.test.ts` and `src/lib/ingest.prompt.test.ts`.
  `src/lib/ingest-source-path-collision.test.ts` had its merge fake matched to
  the real merge prompt.
- `src/lib/scheduled-maintenance.ts`, `src/lib/project-store.ts`,
  `src/lib/dedup-queue.ts`, `src/lib/dedup-storage.ts`, `src/lib/dedup.ts`,
  `src/lib/page-merge.ts`, `src/lib/ingest-queue.ts`, `src/App.tsx`,
  `src/components/settings/sections/maintenance-section.tsx`,
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
  (`isIngestActive`, the only change to `ingest-queue.ts`) – and checks
  again every 5 seconds, so it carries on with no click; a running merge
  holds the project write lock every ingest write takes, from its first
  read to its last write. A merge reply that is empty, has no readable
  frontmatter, or keeps under 70% of the longest page's body (the
  threshold `page-merge.ts` uses, shared from there) is rejected before
  any write, by hand-queued and scheduled merges alike: no page changes,
  none is deleted, the task stays failed with the reason and is not
  retried, a duplicate item goes to the review queue, and the run record
  counts it in `mergesRejected` with the group and reason in
  `rejectedMerges`. Upstream edits to the dedup queue, the dedup merge,
  the ingest queue, the Maintenance screen or project open in `App.tsx`
  need re-checking against this. Tests in
  `src/lib/scheduled-maintenance.test.ts`, `src/lib/dedup-queue.test.ts`,
  `src/lib/merge-ingest-safety.test.ts`, `src/lib/dedup.test.ts` and
  `src/lib/ingest-queue.test.ts`.
- `src/lib/embedding.ts` – `searchByEmbedding` takes an option to throw when
  the vector store search fails, which ingest's candidate search uses so the
  failure reaches its log (#22). Without the option it returns no hits, as
  upstream does.
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
  front-matter setter), is rejected and the old page kept. Embeddings off, a
  failed search, no summaries found, a missing page, a page with no front
  matter or a path not under `wiki/` fail that hub with the reason, and the
  next hub runs. The request is then moved to
  `.llm-wiki/hub-rebuild-archive/<time>.json` with each hub's result. The
  run's line in `maintenance-runs.jsonl` lists the hubs rebuilt and rejected.
  The ingest queue and the switch are re-read before each hub and before each
  write; a hub whose page changed on disk during its model call fails and is
  kept as it is. If the queue or switch changed, the run stops with the
  request in place, stays due, and redoes on the next run any hub it had
  already rebuilt. An unreadable request is left in place and the run records
  why. Tests in `src/lib/scheduled-maintenance.test.ts`.
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

Needs Node 20 or later (built here with 22), Rust (installed at
`~/.cargo/bin`, not on the agent PATH) and protoc, which upstream's README
lists (`brew install protobuf`; installed at `/opt/homebrew/bin/protoc`).

```sh
cd /Users/johnp/Code/llm_wiki
export PATH="$HOME/.cargo/bin:$PATH"
npm ci
npx tauri build --bundles app
```

Output: `src-tauri/target/release/bundle/macos/LLM Wiki.app`. First build about
10 minutes, later builds faster. `--bundles app` skips the `.dmg`: making it
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
