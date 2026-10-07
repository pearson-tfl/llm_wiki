#!/usr/bin/env python3
"""Checks ESTATE.md's list of John's changes on estate: no line in it runs
past 80 characters, and it names every file outside docs/ that this checkout
changes from its merge base with origin/main. A `{a,b}` brace form names each
alternative; a name ending in / names every file under it. Untracked files
are not seen: `git add` a new file first. check.sh runs it first.
Run: scripts/estate/change_list.py
"""

import re
import subprocess
import sys
from pathlib import Path

HEADING = "## John's changes on `estate`"
WIDTH = 80
ROOT = Path(__file__).resolve().parents[2]


def refuse(reason):
    print(f"change_list.py: {reason}", file=sys.stderr)
    sys.exit(1)


def git(*args):
    result = subprocess.run(
        ["git", "-C", str(ROOT), *args], capture_output=True, text=True
    )
    if result.returncode != 0:
        refuse(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def list_section(text):
    """The list's lines as (line number, text), heading to the next ## heading."""
    lines = text.splitlines()
    if HEADING not in lines:
        refuse(f"ESTATE.md has no heading {HEADING!r}")
    start = lines.index(HEADING) + 1
    section = []
    for number, line in enumerate(lines[start:], start + 1):
        if line.startswith("## "):
            break
        section.append((number, line))
    return section


def expand(name):
    """`src/i18n/{en,it}.json` gives `src/i18n/en.json` and `src/i18n/it.json`."""
    brace = re.search(r"\{([^{}]*,[^{}]*)\}", name)
    if not brace:
        return [name]
    head, tail = name[: brace.start()], name[brace.end() :]
    alternatives = brace.group(1).split(",")
    return [path for alt in alternatives for path in expand(head + alt + tail)]


def names_in(section):
    text = "\n".join(line for _, line in section)
    spans = re.findall(r"`([^`]+)`", text)
    return {path for span in spans for word in span.split() for path in expand(word)}


def is_named(path, names):
    folders = (name for name in names if name.endswith("/"))
    return path in names or any(path.startswith(folder) for folder in folders)


def main():
    estate_md = ROOT / "ESTATE.md"
    if not estate_md.is_file():
        refuse(f"no ESTATE.md in {ROOT}")
    section = list_section(estate_md.read_text(encoding="utf-8"))

    base = git("merge-base", "HEAD", "origin/main").strip()
    changed = git("diff", "--name-only", "--no-renames", "-z", base).split("\0")
    required = [path for path in changed if path and not path.startswith("docs/")]
    names = names_in(section)

    long_lines = [(n, len(line)) for n, line in section if len(line) > WIDTH]
    unlisted = [path for path in required if not is_named(path, names)]
    for number, width in long_lines:
        print(f"ESTATE.md:{number}: {width} characters, over {WIDTH}")
    for path in unlisted:
        print(f"ESTATE.md: the change list does not name {path}")
    if long_lines or unlisted:
        sys.exit(1)
    print(
        f"change_list.py: ESTATE.md's change list names all {len(required)}"
        f" changed files outside docs/, in lines of {WIDTH} characters or fewer"
    )


if __name__ == "__main__":
    main()
