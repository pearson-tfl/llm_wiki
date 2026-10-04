#!/usr/bin/env python3
"""Rename the learn-agent-arch-ext- sources of an LLM Wiki vault to their titles.

pearson-tfl/llm_wiki#3. The fixed old-to-new list is ext-rename-map.tsv.

    rename_ext_sources.py check VAULT [--full]
    rename_ext_sources.py apply VAULT
    rename_ext_sources.py embed VAULT

`apply` renames each listed raw source, its raw/assets folder, its
wiki/sources page and its wiki/media folder, and rewrites every mention in
wiki/**/*.md and in the renamed raw sources. In .llm-wiki/ it rewrites the
old names in review.json (sourcePath, affectedPages) and ingest-cache.json
(filesWritten); the app moves the ingest-cache keys itself. Run it only with
LLM Wiki quit and .llm-wiki/ backed up.

`embed` runs after the app is reopened: it re-embeds each renamed
wiki/sources page through the app's API, then searches five of their titles.

On its next start the app compares raw/sources against
.llm-wiki/file-snapshot.json. A deleted path and a created path with the same
content hash, both unique and at least 32 bytes, are migrated as a move;
anything else is a delete (the source's pages go) plus a new source
(re-ingested). So for each raw source whose bytes the rewrite changes, `apply`
records the new content's hash and size under the old path in the snapshot,
and it refuses, before writing anything, whatever would break that pairing.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PREFIX = "learn-agent-arch-ext-"
MAP_FILE = Path(__file__).with_name("ext-rename-map.tsv")
SNAPSHOT = ".llm-wiki/file-snapshot.json"
REVIEW = ".llm-wiki/review.json"
INGEST_CACHE = ".llm-wiki/ingest-cache.json"
PROJECT = ".llm-wiki/project.json"
API_BASE = "http://127.0.0.1:19828/api/v1"
API_TOKEN = Path.home() / ".config/llm-wiki/api-token"
# A local Ollama embedding of one page takes seconds; this bounds a stall.
API_TIMEOUT_S = 120
PROOF_SEARCHES = 5
# src/lib/project-file-sync.ts, migrateUnchangedSourceMoves: a hash match
# proves a move only for files of at least 32 bytes.
MIN_PAIR_BYTES = 32
# The four places a listed source's name appears as a file or folder name.
RENAMED_PLACES = (
    ("raw/sources", ".md"),
    ("raw/assets", ""),
    ("wiki/sources", ".md"),
    ("wiki/media", ""),
)

PREFIX_RE = re.compile(re.escape(PREFIX), re.IGNORECASE)
WIKILINK_RE = re.compile(r"\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
MD_LINK_RE = re.compile(r"\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
SRC_RE = re.compile(r"""\bsrc=["']([^"']+)["']""")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


class Refusal(Exception):
    """Raised before any write when the vault or the list is not safe to apply."""


def load_map(path):
    mapping, seen_new = {}, set()
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 2 or not all(p and p == p.strip() and " " not in p for p in parts):
            raise Refusal(f"{path}:{number}: expected 'old<TAB>new', got {line!r}")
        old, new = parts[0].lower(), parts[1]
        if PREFIX_RE.search(new):
            raise Refusal(f"{path}:{number}: new name {new!r} carries the prefix")
        if old in mapping or wiki_key(new) in seen_new:
            raise Refusal(f"{path}:{number}: {old!r} or {new!r} is listed twice")
        mapping[old] = new
        seen_new.add(wiki_key(new))
    return mapping


def wiki_key(name):
    """normalizeWikiRefKey in src/lib/wiki-cleanup.ts: the app's link key."""
    leaf = name.strip().replace("\\", "/").split("/")[-1]
    if leaf.lower().endswith(".md"):
        leaf = leaf[:-3]
    return re.sub(r"[\s\-_]+", "", leaf.lower())


def md5(data):
    return hashlib.md5(data).hexdigest()


def rel(vault, path):
    return path.relative_to(vault).as_posix()


def read_text(path):
    try:
        return path.read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError) as err:
        raise Refusal(f"cannot read {path}: {err}") from err


def mention_pattern(mapping):
    names = "|".join(re.escape(old) for old in sorted(mapping, key=len, reverse=True))
    return re.compile(re.escape(PREFIX) + f"({names})(?![A-Za-z0-9_-])", re.IGNORECASE)


def rewrite(text, mapping, pattern, where, problems):
    """Replace every listed old name; record any prefix the list does not cover."""
    for hit in PREFIX_RE.finditer(text):
        if not pattern.match(text, hit.start()):
            problems.append(f"{where}: mention not on the list: {text[hit.start():hit.start() + 60]!r}")

    def replace(match):
        new = mapping[match.group(1).lower()]
        return new[0].upper() + new[1:] if match.group(0)[0].isupper() else new

    return pattern.sub(replace, text)


def wiki_pages(vault):
    return sorted(p for p in (vault / "wiki").rglob("*.md") if p.is_file())


def prefixed_names(vault):
    return sorted(
        rel(vault, p)
        for top in ("raw", "wiki")
        for p in (vault / top).rglob("*")
        if PREFIX_RE.search(p.name)
    )


def read_store(vault, name, check_shape):
    try:
        data = json.loads((vault / name).read_text(encoding="utf-8"))
        check_shape(data)
    except (OSError, ValueError, KeyError, TypeError) as err:
        raise Refusal(f"cannot read {name}: {err}") from err
    return data


def require(condition, message):
    if not condition:
        raise TypeError(message)


def snapshot_shape(data):
    require(isinstance(data["files"], dict), "'files' is not an object")


def review_shape(data):
    require(isinstance(data, list) and all(isinstance(i, dict) for i in data), "not a list of items")


def cache_shape(data):
    require(isinstance(data["entries"], dict), "'entries' is not an object")
    require(all(isinstance(e, dict) for e in data["entries"].values()), "an entry is not an object")


def write_json(path, data):
    tmp = path.with_name(path.name + ".ext-rename-tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def rewrite_stores(vault, mapping, pattern, problems):
    """Rewrite the old names in the ruled fields of review.json and ingest-cache.json."""
    review = read_store(vault, REVIEW, review_shape)
    cache = read_store(vault, INGEST_CACHE, cache_shape)
    before = {REVIEW: json.dumps(review), INGEST_CACHE: json.dumps(cache)}
    for item in review:
        where = f"{REVIEW} {item.get('id')}"
        if isinstance(item.get("sourcePath"), str):
            item["sourcePath"] = rewrite(item["sourcePath"], mapping, pattern, where, problems)
        if isinstance(item.get("affectedPages"), list):
            item["affectedPages"] = [
                rewrite(p, mapping, pattern, where, problems) if isinstance(p, str) else p
                for p in item["affectedPages"]
            ]
    for key, entry in cache["entries"].items():
        if isinstance(entry.get("filesWritten"), list):
            entry["filesWritten"] = [
                rewrite(p, mapping, pattern, f"{INGEST_CACHE} {key}", problems) if isinstance(p, str) else p
                for p in entry["filesWritten"]
            ]
    # The app moves the cache keys itself; any other old name is outside the ruling.
    leftovers = [(REVIEW, review), (INGEST_CACHE, list(cache["entries"].values()))]
    for name, data in leftovers:
        if PREFIX_RE.search(json.dumps(data, ensure_ascii=False)):
            problems.append(f"{name}: an old name sits outside the fields this script rewrites")
    after = {REVIEW: review, INGEST_CACHE: cache}
    return {vault / name: data for name, data in after.items() if json.dumps(data) != before[name]}


def plan(vault, mapping):
    """Work out every write; raise Refusal listing every problem found."""
    vault = Path(vault)
    problems, renames, writes = [], [], {}
    pattern = mention_pattern(mapping)
    snapshot = read_store(vault, SNAPSHOT, snapshot_shape)

    covered = set()
    for old, new in mapping.items():
        for folder, ext in RENAMED_PLACES:
            src = vault / folder / f"{PREFIX}{old}{ext}"
            dst = vault / folder / f"{new}{ext}"
            if not src.exists():
                if folder == "raw/sources":
                    problems.append(f"{rel(vault, src)} is missing")
                continue
            covered.add(rel(vault, src))
            if dst.exists():
                problems.append(f"{rel(vault, dst)} exists")
            renames.append((src, dst))
    for name in prefixed_names(vault):
        if name not in covered:
            problems.append(f"{name}: prefixed name not on the list")

    renamed_keys = {wiki_key(new): new for new in mapping.values()}
    for page in wiki_pages(vault):
        if PREFIX_RE.search(page.name):
            continue
        if wiki_key(page.stem) in renamed_keys:
            problems.append(
                f"{rel(vault, page)} has the same link key as new name {renamed_keys[wiki_key(page.stem)]!r}"
            )

    sources_dir = vault / "raw/sources"
    listed_sources = {sources_dir / f"{PREFIX}{old}.md" for old in mapping}
    for path in sorted(p for p in sources_dir.rglob("*") if p.is_file()):
        if path not in listed_sources and PREFIX_RE.search(read_text(path)):
            problems.append(f"{rel(vault, path)} mentions the prefix but is not on the list")

    snapshot_updates, by_hash = {}, {}
    for path in sorted(listed_sources):
        if not path.exists():
            continue
        key = rel(vault, path)
        before = path.read_bytes()
        after = rewrite(read_text(path), mapping, pattern, key, problems).encode("utf-8")
        entry = snapshot["files"].get(key)
        if not isinstance(entry, dict) or entry.get("hash") != md5(before):
            problems.append(f"{key}: the app's snapshot does not record its current content")
        if min(len(before), len(after)) < MIN_PAIR_BYTES:
            problems.append(f"{key} is under {MIN_PAIR_BYTES} bytes, too small to pair as a move")
        by_hash.setdefault(md5(after), []).append(key)
        if after != before:
            writes[path] = after
            snapshot_updates[key] = {"hash": md5(after), "size": len(after)}
    for keys in by_hash.values():
        if len(keys) > 1:
            problems.append(f"{', '.join(keys)} share content, so the app cannot pair them as moves")

    for page in wiki_pages(vault):
        text = read_text(page)
        new_text = rewrite(text, mapping, pattern, rel(vault, page), problems)
        if new_text != text:
            writes[page] = new_text.encode("utf-8")

    stores = rewrite_stores(vault, mapping, pattern, problems)

    if problems:
        raise Refusal("refused, nothing written:\n  " + "\n  ".join(problems))
    for key, update in snapshot_updates.items():
        snapshot["files"][key].update(update)
    if snapshot_updates:
        stores[vault / SNAPSHOT] = snapshot
    return renames, writes, stores


def apply(vault, mapping):
    vault = Path(vault)
    renames, writes, stores = plan(vault, mapping)
    moved = {}
    # Folders first, then files, so a file's new home is ready.
    for src, dst in sorted(renames, key=lambda pair: not pair[0].is_dir()):
        os.rename(src, dst)
        moved[src] = dst
    for path, data in writes.items():
        moved.get(path, path).write_bytes(data)
    for path, data in stores.items():
        write_json(path, data)
    raw_rewritten = sorted(moved.get(p, p).name for p in writes if p.parent == vault / "raw/sources")
    return {
        "renamed": len(renames),
        "rewritten": len(writes),
        "raw_rewritten": raw_rewritten,
        "stores": sorted(rel(vault, p) for p in stores),
    }


def frontmatter_list(text, key):
    if not text.startswith("---"):
        return []
    end = text.find("\n---", 3)
    # The vault writes these lists inline, as [a, b]; it has no block lists.
    for line in text[3:end if end >= 0 else len(text)].splitlines():
        match = re.match(rf"^{key}:\s*(\[.*)$", line)
        if match:
            items = re.findall(r'"([^"]*)"|\'([^\']*)\'|([^,\[\]\s][^,\[\]]*)', match.group(1))
            return [next(x for x in item if x).strip() for item in items if any(item)]
    return []


def unwrap(ref):
    match = re.match(r"^\[\[([^\]|#]*)", ref)
    return match.group(1) if match else ref


def broken_relative(vault, path, text):
    broken = []
    for target in MD_LINK_RE.findall(text) + SRC_RE.findall(text):
        if target.startswith(("#", "/")) or SCHEME_RE.match(target):
            continue
        clean = urllib.parse.unquote(target.split("#")[0].split("?")[0])
        if clean and not (path.parent / clean).exists():
            broken.append(f"{rel(vault, path)} -> {target}")
    return broken


def check(vault):
    """Count prefixed names and mentions, and list every broken link."""
    vault = Path(vault)
    pages = wiki_pages(vault)
    page_keys = {wiki_key(p.stem) for p in pages}
    source_files = [p for p in (vault / "raw/sources").rglob("*") if p.is_file()]
    source_names = {p.name.lower() for p in source_files}
    source_names |= {rel(vault, p)[len("raw/sources/"):].lower() for p in source_files}
    summary_names = {p.name.lower() for p in (vault / "wiki/sources").glob("*.md")}
    raw_sources = sorted(p for p in (vault / "raw/sources").rglob("*.md") if p.is_file())

    wikilinks, refs, rel_wiki, rel_raw = [], [], [], []
    mentions = {"raw": 0, "wiki": 0}
    for path in raw_sources:
        text = path.read_bytes().decode("utf-8", errors="replace")
        mentions["raw"] += bool(PREFIX_RE.search(text))
        rel_raw += broken_relative(vault, path, text)
    for path in pages:
        text = path.read_bytes().decode("utf-8", errors="replace")
        where = rel(vault, path)
        mentions["wiki"] += bool(PREFIX_RE.search(text))
        for target in WIKILINK_RE.findall(text):
            if target.strip() and wiki_key(target) not in page_keys:
                wikilinks.append(f"{where} -> [[{target}]]")
        for ref in frontmatter_list(text, "related"):
            if wiki_key(unwrap(ref)) not in page_keys:
                refs.append(f"{where} related: {ref}")
        for ref in frontmatter_list(text, "sources"):
            name = ref.replace("\\", "/").lower()
            if SCHEME_RE.match(ref) or name.removeprefix("raw/sources/") in source_names or name in summary_names:
                continue
            refs.append(f"{where} sources: {ref}")
        rel_wiki += broken_relative(vault, path, text)

    return {
        "prefixed_names": prefixed_names(vault),
        "files_mentioning_prefix": mentions,
        "broken_wikilinks": len(wikilinks),
        "broken_frontmatter_refs": len(refs),
        "broken_relative_links_wiki": len(rel_wiki),
        "broken_relative_links_raw": len(rel_raw),
        "broken": sorted(wikilinks + refs + rel_wiki + rel_raw),
    }


def api_post(base, route, body, token):
    request = urllib.request.Request(
        f"{base}{route}",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=API_TIMEOUT_S) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as err:
        err.close()
        raise


def page_title(path):
    for line in read_text(path).splitlines()[1:]:
        if line.startswith("title:"):
            return line[len("title:"):].strip().strip("\"'")
        if line == "---":
            break
    return path.stem


def embed(vault, mapping, base=API_BASE, token_file=API_TOKEN):
    """Re-embed each renamed wiki/sources page through the running app's API."""
    vault = Path(vault)
    project = read_store(vault, PROJECT, lambda d: require(isinstance(d["id"], str), "no project id"))
    try:
        token = Path(token_file).read_text(encoding="utf-8").strip()
    except OSError as err:
        raise Refusal(f"cannot read the API token file {token_file}: {err.strerror}") from err
    if not token:
        raise Refusal(f"the API token file {token_file} is empty")
    route = f"/projects/{urllib.parse.quote(project['id'])}"
    pages = [f"wiki/sources/{new}.md" for new in mapping.values()]
    report = {"embedded": [], "failed": [], "searches": []}
    # One page per call, one call at a time: the route takes a single path
    # and turns away a fifth request in flight.
    for page in pages:
        try:
            api_post(base, f"{route}/pages/embed", {"path": page}, token)
            report["embedded"].append(page)
        except (urllib.error.URLError, OSError, ValueError) as err:
            report["failed"].append(f"{page}: {err}")
    for page in pages[:PROOF_SEARCHES]:
        title = page_title(vault / page)
        try:
            results = api_post(base, f"{route}/search", {"query": title, "topK": 10}, token)["results"]
        except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
            report["searches"].append({"title": title, "error": str(err)})
            continue
        hit = next((r for r in results if str(r.get("path", "")).endswith(page)), None)
        report["searches"].append(
            {"title": title, "path": hit and hit["path"], "vectorScore": hit and hit.get("vectorScore")}
        )
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("check", "apply", "embed"))
    parser.add_argument("vault", type=Path)
    parser.add_argument("--full", action="store_true", help="check: also list every broken link")
    args = parser.parse_args(argv)
    try:
        if args.command == "apply":
            print(json.dumps(apply(args.vault, load_map(MAP_FILE))))
            return 0
        if args.command == "embed":
            # Read here, not bound as embed's defaults, so a test can patch them.
            report = embed(args.vault, load_map(MAP_FILE), API_BASE, API_TOKEN)
            print(json.dumps(report, indent=2))
            proven = all(s.get("path") and s.get("vectorScore") is not None for s in report["searches"])
            return 0 if not report["failed"] and proven else 1
        report = check(args.vault)
        if not args.full:
            report.pop("broken")
            report["prefixed_names"] = len(report["prefixed_names"])
        print(json.dumps(report, indent=2))
        return 0
    except Refusal as err:
        print(err, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
