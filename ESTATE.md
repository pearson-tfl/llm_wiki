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
- `src/lib/__tests__/claude-cli-transport.test.ts` – the hint test expects
  that command.
- `src-tauri/src/agent/runtime.rs` – upstream PR nashsu/llm_wiki#727
  (unmerged there when taken, 26 Sep 2026), cherry-picked as is: with the
  Claude Code or Codex CLI provider, a chat question that matches no wiki page
  no longer fails with "Backend Agent LLM is not configured" before `claude`
  starts (upstream issues #696, #703, #720). When an upstream release contains
  #727, take upstream's version of this file. Side effect: HTTP API / MCP
  callers on a CLI provider now get a "did not find matching wiki pages" reply
  instead of an error. Known gap it does not fix: with a CLI provider, pages
  attached with @ never reach the model.
- `ESTATE.md` – this file.

## Build

Needs Node 20 or later (built here with 22) and Rust (installed at
`~/.cargo/bin`, not on the agent PATH).

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

Then Build and Install as above. Record the release, the new commit and the
test result on the ticket.
