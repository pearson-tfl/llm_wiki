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
  exact commit the app was built from. No manual bump needed.
- `src/lib/update-check.test.ts` – one test: the stamp does not confuse the
  update check.
- `ESTATE.md` – this file.

## Build

Needs Node 22 and Rust (installed at `~/.cargo/bin`, not on the agent PATH).

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

1. Quit LLM Wiki (John quits it, or `kill` its pid – not `osascript`, which
   raises an Automation permission dialog).
2. Archive the old app and its data to
   `~/Room-101/<date>-llm-wiki-<old version>/`: the `.app`, plus
   `~/Library/{Application Support,Caches,WebKit}/com.llmwiki.app` under
   `data/`. Add the folder to Room 101's `.gitignore` and an `INDEX.md`
   entry; commit. Leave the data folders in place – the new build reuses them.
3. `ditto` the new `.app` to `/Applications/LLM Wiki.app`.
4. Open it. Check Settings > About shows the new stamp and John's wikis load.

## Taking an upstream release

The app's own update banner checks nashsu's releases. Treat it as the signal
to run this routine. Do not download the upstream `.dmg`: it replaces the
estate build with nashsu's.

```sh
cd /Users/johnp/Code/llm_wiki
git fetch upstream --tags
git diff --name-only main...estate        # files estate changed; compare with the list above
git switch main && git merge --ff-only vX.Y.Z && git push origin main
git switch estate && git merge vX.Y.Z     # conflicts only in the files above
npm ci && npm run typecheck && npm run test:mocks
git push origin estate
```

Then Build and Install as above. Record the release, the new commit and the
test result on the ticket.
