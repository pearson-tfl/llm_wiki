"""Tests for change_list.py (pearson-tfl/llm_wiki#91).

Each test runs a copy of the script inside a throwaway git repository in its
own temp folder, with an origin/main ref standing in for upstream. The list
lines are copied from ESTATE.md as it stood on estate at 5a4149b.
Run: python3 -m unittest discover -s scripts/estate -p 'test_change_list.py'
"""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("change_list.py")

HEAD = """# Estate fork of LLM Wiki

## John's changes on `estate`

Keep this list current. Merge conflicts can only come from these files.

"""

TAIL = """
## Build

```sh
git diff --name-only main...estate        # files estate changed; compare with the list above
```
"""

# ESTATE.md's own list lines: a brace form, a folder form, a span holding a
# command line, an en dash and a wrapped entry.
ENTRIES = """- `vite.config.ts` – version stamp. Settings > About shows
  `v<release>+estate.<commit>`, e.g. `v0.6.11+estate.e808211`, naming the
- `src/i18n/{en,it,ru,zh}.json` – the new strings, in all four languages.
- `src/lib/__tests__/fixtures/claude-cli/` – recorded stdin fixtures.
- `scripts/estate/live-cli.sh <stdin.jsonl> <output>` runs the CLI once.
- `src/lib/claude-cli-transport.ts`,
  `src/lib/__tests__/claude-cli-transport.test.ts` – the transport.
- `ESTATE.md` – this file.
"""

LISTED = [
    "vite.config.ts",
    "src/i18n/en.json",
    "src/i18n/it.json",
    "src/i18n/ru.json",
    "src/i18n/zh.json",
    "src/lib/__tests__/fixtures/claude-cli/piped-history.stdin.jsonl",
    "scripts/estate/live-cli.sh",
    "src/lib/claude-cli-transport.ts",
    "src/lib/__tests__/claude-cli-transport.test.ts",
]


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t",
         "-c", "commit.gpgsign=false", *args],
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def write(repo, path, text="x\n"):
    file = repo / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf-8")


class ChangeListTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "repo"
        script = self.repo / "scripts/estate/change_list.py"
        script.parent.mkdir(parents=True)
        git(self.repo, "init", "-q")
        # Upstream: one file estate leaves alone, and every file it changes.
        write(self.repo, "README.md")
        for path in LISTED:
            write(self.repo, path)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "upstream")
        git(self.repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        # Estate: the script, the list, a doc, and a change to every listed file.
        shutil.copy(SCRIPT, script)
        write(self.repo, "ESTATE.md", HEAD + ENTRIES + TAIL)
        write(self.repo, "docs/adr/0001-estate-is-the-trunk.md")
        for path in LISTED:
            write(self.repo, path, "estate\n")
        self.commit("estate")

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, message):
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", message)

    def run_script(self):
        result = subprocess.run(
            ["python3", str(self.repo / "scripts/estate/change_list.py")],
            cwd=Path(self.tmp.name), capture_output=True, text=True,
        )
        return result.returncode, result.stdout + result.stderr

    def set_entries(self, entries):
        write(self.repo, "ESTATE.md", HEAD + entries + TAIL)

    def test_passes_when_every_changed_file_is_named(self):
        # The script itself is unlisted in ENTRIES, so name it here.
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n")
        self.commit("list the script")
        code, out = self.run_script()
        self.assertEqual(code, 0, out)

    def test_fails_on_an_unlisted_file_under_src(self):
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n")
        write(self.repo, "src/lib/new-thing.ts")
        self.commit("unlisted")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("src/lib/new-thing.ts", out)

    def test_names_every_unlisted_file(self):
        write(self.repo, "src/lib/new-thing.ts")
        self.commit("unlisted")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("src/lib/new-thing.ts", out)
        self.assertIn("scripts/estate/change_list.py", out)

    def test_a_basename_alone_does_not_name_a_file(self):
        self.set_entries(ENTRIES + "- `change_list.py`.\n")
        self.commit("basename only")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("scripts/estate/change_list.py", out)

    def test_a_folder_form_names_only_files_under_it(self):
        self.set_entries(ENTRIES + "- `scripts/estate/`.\n")
        write(self.repo, "scripts/estate-other/x.sh")
        self.commit("folder form")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("scripts/estate-other/x.sh", out)
        self.assertNotIn("scripts/estate/change_list.py", out)

    def test_a_brace_form_names_only_its_alternatives(self):
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n")
        write(self.repo, "src/i18n/fr.json")
        self.commit("a fifth language")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("src/i18n/fr.json", out)
        self.assertNotIn("src/i18n/en.json", out)

    def test_files_under_docs_need_no_entry(self):
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n")
        write(self.repo, "docs/agents/new-doc.md")
        self.commit("a doc")
        code, out = self.run_script()
        self.assertEqual(code, 0, out)

    def test_a_root_markdown_file_needs_an_entry(self):
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n")
        write(self.repo, "README.md", "estate\n")
        self.commit("readme")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("README.md", out)

    def test_a_deleted_upstream_file_needs_an_entry(self):
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n")
        (self.repo / "README.md").unlink()
        self.commit("delete readme")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("README.md", out)

    def test_a_renamed_upstream_file_needs_both_names(self):
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`, `README.txt`.\n")
        git(self.repo, "mv", "README.md", "README.txt")
        self.commit("rename readme")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("README.md", out)

    def test_uncommitted_edits_count(self):
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n")
        self.commit("list the script")
        write(self.repo, "README.md", "edited\n")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("README.md", out)

    def test_fails_on_an_81_character_line(self):
        line = "  " + "x" * 79 + "\n"
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n" + line)
        self.commit("long line")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("ESTATE.md:", out)
        self.assertIn("81", out)

    def test_an_80_character_line_of_en_dashes_passes(self):
        # 80 characters, 238 bytes: width counts characters.
        line = "  " + "–" * 78 + "\n"
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n" + line)
        self.commit("en dashes")
        code, out = self.run_script()
        self.assertEqual(code, 0, out)

    def test_long_lines_outside_the_list_pass(self):
        # TAIL's code block line is over 80 characters.
        self.set_entries(ENTRIES + "- `scripts/estate/change_list.py`.\n")
        self.commit("list the script")
        self.assertGreater(max(len(l) for l in TAIL.splitlines()), 80)
        code, out = self.run_script()
        self.assertEqual(code, 0, out)

    def test_refuses_without_the_list_heading(self):
        write(self.repo, "ESTATE.md", "# Estate fork of LLM Wiki\n" + ENTRIES)
        self.commit("no heading")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("John's changes on `estate`", out)

    def test_refuses_without_estate_md(self):
        (self.repo / "ESTATE.md").unlink()
        self.commit("no list")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("ESTATE.md", out)

    def test_refuses_without_origin_main(self):
        git(self.repo, "update-ref", "-d", "refs/remotes/origin/main")
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertIn("origin/main", out)


if __name__ == "__main__":
    unittest.main()
