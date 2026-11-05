# LLM Wiki: John's estate build

John's own build of the open-source LLM Wiki desktop app: the fork
`pearson-tfl/llm_wiki` of `nashsu/llm_wiki`.

## Branches

- `estate` is the trunk: upstream's release plus John's changes, and the
  branch the installed app is built from. Lanes branch from it and merge
  back to it.
- `main` mirrors upstream exactly and never takes a commit.

## Status

The llm_wiki app is on hold, as an experiment that ingested a large
corpus poorly despite remedial fixes. The jep-ai-wiki-1.0 Obsidian vault is
the canonical source for developing the estate's wikis.

## Build, install, verify

`ESTATE.md` is the source for every step: prerequisites, build, install,
the running version's stamp in Settings > About, and taking an upstream
release. It also lists every file
`estate` changes: a change to another upstream file joins that list.

## Agent skills

GitHub Issues, `pearson-tfl/llm_wiki`, via `gh`:
`docs/agents/issue-tracker.md`. Labels: `docs/agents/triage-labels.md`.
Domain: `docs/agents/domain.md`. Always pass `--repo pearson-tfl/llm_wiki`:
a bare `gh` here means upstream, `nashsu/llm_wiki`.

## Local facts

The seat's local paths, account rule and PM seat facts are in
`CLAUDE.local.md`, untracked, because this repository is public.

## Where knowledge goes

A new term goes to GLOSSARY.md, a lasting direction to an ADR, and a
behaviour rule no script can enforce to CODING_STANDARDS.md. A next action
goes to the Firstmate backlog item, because crewmates do not comment on
issues.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
