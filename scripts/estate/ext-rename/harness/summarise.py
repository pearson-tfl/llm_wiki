#!/usr/bin/env python3
"""Summarise a prove-on-copy.sh run (pearson-tfl/llm_wiki#3).

    summarise.py RUN_DIR

Exit 0 when every proof holds, 1 otherwise. Each line names what it measured.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import rename_ext_sources as ers  # noqa: E402

MAPPING = ers.load_map(ers.MAP_FILE)
PATTERN = ers.mention_pattern(MAPPING)


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def renamed(text):
    return ers.rewrite(text, MAPPING, PATTERN, "", [])


def mapped(value):
    """The value with every old name in every string replaced, keys included."""
    if isinstance(value, str):
        return renamed(value)
    if isinstance(value, list):
        return [mapped(v) for v in value]
    if isinstance(value, dict):
        return {renamed(k): mapped(v) for k, v in value.items()}
    return value


def main(run):
    run = Path(run)
    failures = []

    def prove(label, ok, detail=""):
        print(f"{'PASS' if ok else 'FAIL'}  {label}{': ' + str(detail) if detail != '' else ''}")
        if not ok:
            failures.append(label)

    before, after_apply, after_app = (load(run / f"check-{n}.json") for n in ("before", "after-apply", "after-app"))
    print(f"prefixed names: before {len(before['prefixed_names'])}, after apply "
          f"{len(after_apply['prefixed_names'])}, after app start {len(after_app['prefixed_names'])}")
    prove("no prefixed name in raw/ or wiki/ after apply", after_apply["prefixed_names"] == [], after_apply["prefixed_names"][:5])
    prove("no file in raw/ or wiki/ mentions the prefix after apply",
          after_apply["files_mentioning_prefix"] == {"raw": 0, "wiki": 0}, after_apply["files_mentioning_prefix"])
    for key in ("broken_wikilinks", "broken_frontmatter_refs", "broken_relative_links_wiki", "broken_relative_links_raw"):
        print(f"{key}: before {before[key]}, after apply {after_apply[key]}, after app start {after_app[key]}")
    for name, report in (("apply", after_apply), ("app start", after_app)):
        new_breaks = sorted(set(report["broken"]) - {renamed(b) for b in before["broken"]})
        prove(f"no broken link after {name} that was not broken before", not new_breaks, new_breaks[:5])

    old_raw = {f"raw/sources/{ers.PREFIX}{old}.md" for old in MAPPING}
    new_raw = {f"raw/sources/{new}.md" for new in MAPPING.values()}
    for side in ("baseline", "vault"):
        tasks = load(run / f"tasks-{side}.json")
        raw = [t for t in tasks if t["path"].startswith("raw/sources/")]
        kinds = {k: sum(t["kind"] == k for t in raw) for k in ("created", "modified", "deleted")}
        print(f"app startup comparison, {side}: {len(tasks)} tasks; raw/sources {kinds}")
    tasks = load(run / "tasks-vault.json")
    baseline_tasks = {(t["path"], t["kind"]) for t in load(run / "tasks-baseline.json")}
    ours = [t for t in tasks if t["path"] in old_raw | new_raw]
    prove("the comparison sees each of the 68 old raw paths deleted and each new one created",
          sorted((t["kind"], t["path"] in old_raw) for t in ours) == sorted([("created", False)] * 68 + [("deleted", True)] * 68),
          len(ours))
    prove("each pair carries one content hash", all(
        any(t["hashBefore"] == c.get("hashAfter") for c in ours if c["kind"] == "created")
        for t in ours if t["kind"] == "deleted"))
    other_raw = {(t["path"], t["kind"]) for t in tasks if t["path"].startswith("raw/sources/") and t["path"] not in old_raw | new_raw}
    prove("no other raw/sources change beyond the baseline copy's", other_raw <= baseline_tasks, sorted(other_raw - baseline_tasks)[:5])

    base, proc = load(run / "processing-baseline.json"), load(run / "processing-vault.json")
    moves = {(o, n) for o, n in proc["migrateSourcePath"]}
    expected = {(f"raw/sources/{ers.PREFIX}{old}.md", f"raw/sources/{new}.md") for old, new in MAPPING.items()}
    prove("the app migrates all 68 renamed sources as moves", moves == expected, f"{len(moves & expected)} of {len(expected)}")
    rewritten = set(load(run / "apply.json").get("raw_rewritten", []))
    prove("the 30 with rewritten image links are among them", {f"raw/sources/{n}" for n in rewritten} <= {n for _, n in moves}, len(rewritten))
    deleted_raw = [p for call in proc["deleteSourceFiles"] for p in call]
    prove("zero source deletes", not deleted_raw, deleted_raw[:5])
    prove("zero new sources queued for ingest beyond the baseline's",
          (proc["enqueueSourceIngest"], proc["enqueueBatch"]) == (base["enqueueSourceIngest"], base["enqueueBatch"]),
          f"{len(proc['enqueueSourceIngest'])} calls vs baseline {len(base['enqueueSourceIngest'])}")
    prove("no file-sync error", proc["lastError"] is None, proc["lastError"])
    wiki_deleted = [p for call in proc["cleanupDeletedWikiPages"] for p in call]
    print(f"wiki pages the app saw deleted: {len(wiki_deleted)} (baseline {sum(len(c) for c in base['cleanupDeletedWikiPages'])}); "
          f"embeddings removed: {len(proc['removePageEmbedding'])}")
    prove("the only wiki pages seen as deleted are the old summary pages",
          set(wiki_deleted) - {p for c in base["cleanupDeletedWikiPages"] for p in c}
          <= {f"wiki/sources/{ers.PREFIX}{old}.md" for old in MAPPING})

    for store in ("review.json", "ingest-cache.json"):
        original = load(run / "baseline/.llm-wiki" / store)
        applied = load(run / "stores-after-apply" / store)
        started = load(run / "vault/.llm-wiki" / store)
        count = (lambda d: len(d)) if store == "review.json" else (lambda d: len(d["entries"]))
        prove(f"{store}: same item count after apply", count(original) == count(applied), f"{count(original)} -> {count(applied)}")
        prove(f"{store}: nothing changed but old names in strings", mapped(original) == mapped(applied))
        refs = [json.dumps(d).count(ers.PREFIX) for d in (original, applied, started)]
        print(f"{store}: old-name references before {refs[0]}, after apply {refs[1]}, after app start {refs[2]}")
        prove(f"{store}: zero old-name references after app start", refs[2] == 0)

    print("ALL PROOFS HOLD" if not failures else f"{len(failures)} PROOF(S) FAILED")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
