# Estate is the trunk; main stays the upstream mirror

Status: accepted, 3 October 2026. Recorded by the Agent-Harness-Reconfig PM
on pearson-tfl/Agent-Harness-Reconfig#2940, when this repository became a
project with its own PM seat, `llm-wiki-pm` (#2941).

## Decision

- **Trunk.** `estate` is the trunk. Lanes branch from `origin/estate` and
  merge back to it; the installed app is built from it.
- **GitHub's default branch stays `main`.** `main` is an exact mirror of
  `nashsu/llm_wiki` and never takes a commit. It is not changed to
  `estate`.
- **Coding standards by pointer.** `CODING_STANDARDS.md` points to the
  estate's file, `/Users/johnp/Code/Agent-Harness-Reconfig/CODING_STANDARDS.md`;
  it is not copied here.

## Why

`ESTATE.md` already ran the fork this way: `main` mirrors upstream so an
upstream release fast-forwards it cleanly, and `estate` carries John's
changes on top. Making `estate` the trunk keeps that layout instead of
inventing a second one. A copy of the coding standards would drift from the
estate's; a pointer cannot.

## Consequences

- A tool that assumes the default branch is the trunk – a pull request's
  base, `gh pr create` without `--base` – targets `main` here. Name
  `estate` explicitly.
- An upstream release is taken by the routine in `ESTATE.md`, "Taking an
  upstream release": `main` first, then merged into `estate`.
