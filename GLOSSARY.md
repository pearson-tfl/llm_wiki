# LLM Wiki – the estate build

John's own build of the open-source LLM Wiki desktop app: the fork
`pearson-tfl/llm_wiki` of `nashsu/llm_wiki`, built and installed on John's
Mac from the estate branch. A domain glossary only; build and install
steps are in `ESTATE.md`, decisions in `docs/adr/`.

## Language

### The fork

**Upstream**:
The open-source project `nashsu/llm_wiki`, the `upstream` remote. Its
releases are tagged `vX.Y.Z`; the app's update banner checks them.
_Avoid_: origin, the original

**Main**:
The `main` branch of the fork: an exact mirror of upstream, never committed
to. It stays GitHub's default branch.
_Avoid_: trunk

**Estate branch**:
The `estate` branch: an upstream release plus John's changes. The trunk –
lanes branch from it and merge back to it – and the branch the installed
app is built from.
_Avoid_: fork branch, John's branch

**Estate change**:
A file the estate branch changes from upstream, listed in `ESTATE.md`. Only
these files can conflict when an upstream release is merged in.
_Avoid_: patch, customisation

**Version stamp**:
The version Settings > About shows, `v<release>+estate.<commit>`, naming
the exact commit the installed app was built from; `-dirty` on the end
means the build had uncommitted edits. The way to tell which build is
running. Finder's Get Info shows the plain release, not the stamp.
_Avoid_: build number, version

**Installed build**:
The app at `/Applications/LLM Wiki.app`, built from the estate branch and
installed by the steps in `ESTATE.md`.
_Avoid_: release, the dmg

### The app

**Wiki project**:
A folder the app opens as one wiki: `raw/` holds the sources, `wiki/` the
pages the app writes from them, `purpose.md` and `schema.md` steer it.
_Avoid_: vault (except for the Agent Harness Wiki vault, below)

**Ingest queue**:
A wiki project's list of sources waiting for, in, or past ingest, each
pending, processing, done, failed or cancelled. Saved per project in
`.llm-wiki/ingest-queue.json`; the activity panel shows it.
_Avoid_: import list, job queue

**Agent Harness Wiki vault**:
`/Users/johnp/Code/Agent-Harness-Reconfig/Agent-Harness-Wiki-Experiment`, a
wiki project holding John's content. A content folder: this repository's
lanes write in it only for a content ticket, and its content is not
product code.
_Avoid_: the wiki (ambiguous with the app)
