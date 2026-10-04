"""Tests for rename_ext_sources.py (pearson-tfl/llm_wiki#3).

Each test builds its own vault in its own temporary folder. The fixture
lines are copied from the Agent Harness Wiki as it stood on 4 Oct 2026.
Run: python3 -m unittest discover -s scripts/estate/ext-rename
"""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import rename_ext_sources as ers

P = "learn-agent-arch-ext-"

# raw/sources/learn-agent-arch-ext-a2a-readme.md, first lines.
RAW_WITH_ASSETS = (
    "> Source: https://github.com/a2aproject/A2A (fetched 2026-09-29 via "
    "learn-agent-architecture links)\n\n"
    "# Agent2Agent (A2A) Protocol\n\n"
    f"[![PyPI - Version](../assets/{P}a2a-readme/a2a-sdk.svg)]"
    "(https://pypi.org/project/a2a-sdk)\n"
    f'  <img src="../assets/{P}a2a-readme/Mvosg4klCA4.svg" alt="Ask Code Wiki" height="20">\n'
)
RAW_PLAIN = (
    "> Source: https://github.com/openai/swarm (fetched 2026-09-29 via "
    "learn-agent-architecture links)\n\n# Swarm (experimental, educational)\n"
)
RAW_SPEC = "> Source: https://modelcontextprotocol.io/specification/2026-07-28\n\n# Specification\n"
RAW_CHANGELOG = (
    "> Source: https://modelcontextprotocol.io/specification/2026-07-28/changelog\n\n# Key Changes\n"
)

SWARM_SUMMARY = (
    "---\ntype: source\n"
    'title: "Swarm README: Agent Handoffs and Caller-Managed State"\n'
    "related: [swarm, openai-agents-sdk, agent-handoffs]\n"
    f'sources: ["{P}openai-swarm-readme.md"]\n'
    "---\n# Swarm README\n"
)
EVENT_LEDGER = (
    "---\ntype: concept\ntitle: Event Ledger\n"
    f"related: [{P}openai-swarm-readme, swarm, {P}mcp-spec-2026-07-28-changelog]\n"
    f'sources: ["{P}openai-swarm-readme.md", "{P}mcp-spec-2026-07-28.md"]\n'
    "---\n# Event Ledger\n\n"
    f"[[Learn-agent-arch-ext-openai-swarm-readme]] recommends this structure.\n"
    f"See [[{P}mcp-spec-2026-07-28|the spec]] and [[{P}mcp-spec-2026-07-28-changelog]].\n"
    f'source: "[[{P}a2a-readme]]"\n'
    "[[swarm]] and [[missing-page]].\n"
)
LOG = (
    f"- Ingested `{P}openai-swarm-readme.md`\n"
    f"- Ingested {P}a2a-readme.md\n"
)

MAP = {
    "a2a-readme": "agent2agent-a2a-protocol-readme",
    "openai-swarm-readme": "swarm-readme",
    "mcp-spec-2026-07-28": "mcp-specification-2026-07-28",
    "mcp-spec-2026-07-28-changelog": "mcp-specification-2026-07-28-key-changes",
}


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


class VaultCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self._tmp.name) / "vault"
        files = {
            f"raw/sources/{P}a2a-readme.md": RAW_WITH_ASSETS,
            f"raw/sources/{P}openai-swarm-readme.md": RAW_PLAIN,
            f"raw/sources/{P}mcp-spec-2026-07-28.md": RAW_SPEC,
            f"raw/sources/{P}mcp-spec-2026-07-28-changelog.md": RAW_CHANGELOG,
            "raw/sources/other.md": "> Source: elsewhere, not part of this rename.\n",
            f"raw/assets/{P}a2a-readme/a2a-sdk.svg": "<svg/>",
            f"raw/assets/{P}a2a-readme/Mvosg4klCA4.svg": "<svg/>",
            f"wiki/sources/{P}openai-swarm-readme.md": SWARM_SUMMARY,
            f"wiki/sources/{P}a2a-readme.md": "---\ntype: source\n---\n# A2A\n",
            f"wiki/sources/{P}mcp-spec-2026-07-28.md": "# Spec\n",
            f"wiki/sources/{P}mcp-spec-2026-07-28-changelog.md": "# Changelog\n",
            "wiki/entities/swarm.md": "# Swarm\n",
            "wiki/concepts/event-ledger.md": EVENT_LEDGER,
            "wiki/log.md": LOG,
        }
        for rel, text in files.items():
            path = self.vault / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        (self.vault / f"wiki/media/{P}openai-swarm-readme").mkdir(parents=True)
        self.write_snapshot()

    def tearDown(self):
        self._tmp.cleanup()

    def write_snapshot(self, overrides=None):
        entries = {}
        for path in (self.vault / "raw/sources").iterdir():
            data = path.read_bytes()
            entries[f"raw/sources/{path.name}"] = {"hash": md5(data), "size": len(data), "mtimeMs": 1}
        entries.update(overrides or {})
        snap = self.vault / ".llm-wiki/file-snapshot.json"
        snap.parent.mkdir(exist_ok=True)
        snap.write_text(json.dumps({"version": 1, "updatedAt": 1, "files": entries}))

    def snapshot(self):
        return json.loads((self.vault / ".llm-wiki/file-snapshot.json").read_text())["files"]

    def tree(self):
        return {
            str(p.relative_to(self.vault)): (p.read_bytes() if p.is_file() else None)
            for p in sorted(self.vault.rglob("*"))
        }

    def assertRefused(self, fragment):
        before = self.tree()
        with self.assertRaises(ers.Refusal) as caught:
            ers.apply(self.vault, MAP)
        self.assertIn(fragment, str(caught.exception))
        self.assertEqual(before, self.tree(), "a refusal must write nothing")


class ApplyTests(VaultCase):
    def test_renames_every_prefixed_name(self):
        ers.apply(self.vault, MAP)
        for new in MAP.values():
            self.assertTrue((self.vault / f"raw/sources/{new}.md").is_file(), new)
            self.assertTrue((self.vault / f"wiki/sources/{new}.md").is_file(), new)
        self.assertTrue((self.vault / "wiki/media/swarm-readme").is_dir())
        self.assertTrue(
            (self.vault / "raw/assets/agent2agent-a2a-protocol-readme/a2a-sdk.svg").is_file()
        )
        self.assertEqual([], list(self.vault.rglob(f"*{P}*")))

    def test_raw_source_without_asset_links_keeps_its_bytes_and_snapshot_entry(self):
        old = f"raw/sources/{P}openai-swarm-readme.md"
        data = (self.vault / old).read_bytes()
        entry = self.snapshot()[old]
        ers.apply(self.vault, MAP)
        self.assertEqual(data, (self.vault / "raw/sources/swarm-readme.md").read_bytes())
        self.assertEqual(entry, self.snapshot()[old])

    def test_raw_source_with_asset_links_is_rewritten_and_its_snapshot_hash_follows(self):
        old = f"raw/sources/{P}a2a-readme.md"
        entry = self.snapshot()[old]
        ers.apply(self.vault, MAP)
        data = (self.vault / "raw/sources/agent2agent-a2a-protocol-readme.md").read_bytes()
        self.assertEqual(RAW_WITH_ASSETS.replace(f"{P}a2a-readme", "agent2agent-a2a-protocol-readme").encode(), data)
        snap = self.snapshot()
        # The old path keeps its entry with the new content's hash, so the
        # app pairs the deleted old path with the created new one: a move.
        self.assertEqual({**entry, "hash": md5(data), "size": len(data)}, snap[old])
        self.assertNotIn("raw/sources/agent2agent-a2a-protocol-readme.md", snap)
        self.assertEqual(0, ers.check(self.vault)["broken_relative_links_raw"])

    def test_rewrites_every_mention_form(self):
        ers.apply(self.vault, MAP)
        ledger = (self.vault / "wiki/concepts/event-ledger.md").read_text()
        self.assertIn(
            "related: [swarm-readme, swarm, mcp-specification-2026-07-28-key-changes]", ledger
        )
        self.assertIn(
            'sources: ["swarm-readme.md", "mcp-specification-2026-07-28.md"]', ledger
        )
        self.assertIn("[[Swarm-readme]] recommends", ledger)
        self.assertIn("[[mcp-specification-2026-07-28|the spec]]", ledger)
        self.assertIn("[[mcp-specification-2026-07-28-key-changes]]", ledger)
        self.assertIn('source: "[[agent2agent-a2a-protocol-readme]]"', ledger)
        summary = (self.vault / "wiki/sources/swarm-readme.md").read_text()
        self.assertIn('sources: ["swarm-readme.md"]', summary)
        log = (self.vault / "wiki/log.md").read_text()
        self.assertEqual(
            "- Ingested `swarm-readme.md`\n- Ingested agent2agent-a2a-protocol-readme.md\n", log
        )

    def test_check_counts_before_and_after(self):
        before = ers.check(self.vault)
        self.assertEqual(10, len(before["prefixed_names"]))
        self.assertEqual({"raw": 1, "wiki": 3}, before["files_mentioning_prefix"])
        self.assertEqual(1, before["broken_wikilinks"])  # [[missing-page]]
        ers.apply(self.vault, MAP)
        after = ers.check(self.vault)
        self.assertEqual(1, after["broken_wikilinks"])
        self.assertEqual(0, after["broken_frontmatter_refs"])
        self.assertEqual([], after["prefixed_names"])
        self.assertEqual({"raw": 0, "wiki": 0}, after["files_mentioning_prefix"])


class GuardTests(VaultCase):
    def test_refuses_a_prefixed_name_the_list_does_not_cover(self):
        (self.vault / f"wiki/sources/{P}unlisted.md").write_text("# x\n")
        self.assertRefused(f"wiki/sources/{P}unlisted.md")

    def test_refuses_a_mention_the_list_does_not_cover(self):
        (self.vault / "wiki/concepts/stray.md").write_text(f"See [[{P}unlisted]].\n")
        self.assertRefused(f"{P}unlisted")

    def test_refuses_an_existing_target(self):
        (self.vault / "raw/sources/swarm-readme.md").write_text("# taken\n")
        self.write_snapshot()
        self.assertRefused("raw/sources/swarm-readme.md exists")

    def test_refuses_a_new_name_that_collides_with_a_wiki_page_key(self):
        (self.vault / "wiki/entities/Swarm_Readme.md").write_text("# taken\n")
        self.assertRefused("wiki/entities/Swarm_Readme.md")

    def test_refuses_raw_sources_that_share_a_hash(self):
        (self.vault / f"raw/sources/{P}mcp-spec-2026-07-28-changelog.md").write_text(RAW_SPEC)
        self.write_snapshot()
        self.assertRefused("share content")

    def test_refuses_raw_sources_that_would_share_a_hash_after_the_rewrite(self):
        # Differs only in the asset folder name, so equal once rewritten.
        twin = RAW_WITH_ASSETS.replace(f"{P}a2a-readme", "agent2agent-a2a-protocol-readme")
        (self.vault / f"raw/sources/{P}mcp-spec-2026-07-28.md").write_text(twin)
        self.write_snapshot()
        self.assertRefused("share content")

    def test_refuses_a_raw_source_too_small_to_pair(self):
        (self.vault / f"raw/sources/{P}mcp-spec-2026-07-28.md").write_text("# tiny\n")
        self.write_snapshot()
        self.assertRefused("under 32 bytes")

    def test_refuses_a_raw_source_the_snapshot_records_differently(self):
        self.write_snapshot({f"raw/sources/{P}openai-swarm-readme.md": {"hash": "0" * 32}})
        self.assertRefused("snapshot")

    def test_refuses_a_missing_snapshot(self):
        (self.vault / ".llm-wiki/file-snapshot.json").unlink()
        self.assertRefused("file-snapshot.json")

    def test_refuses_an_unparsable_snapshot(self):
        (self.vault / ".llm-wiki/file-snapshot.json").write_text("{not json")
        self.assertRefused("file-snapshot.json")

    def test_refuses_a_listed_source_that_is_missing(self):
        (self.vault / f"raw/sources/{P}a2a-readme.md").unlink()
        self.write_snapshot()
        self.assertRefused(f"raw/sources/{P}a2a-readme.md is missing")


class MapTests(unittest.TestCase):
    def load(self, text):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "map.tsv"
            path.write_text(text)
            return ers.load_map(path)

    def test_loads_the_shipped_list(self):
        mapping = ers.load_map(Path(ers.__file__).with_name("ext-rename-map.tsv"))
        self.assertEqual(68, len(mapping))

    def test_refuses_a_malformed_line(self):
        with self.assertRaises(ers.Refusal):
            self.load("a-readme b-readme\n")

    def test_refuses_a_duplicate_new_name(self):
        with self.assertRaises(ers.Refusal):
            self.load("a\tsame\nb\tsame\n")

    def test_refuses_a_new_name_that_carries_the_prefix(self):
        with self.assertRaises(ers.Refusal):
            self.load(f"a\t{P}a\n")


if __name__ == "__main__":
    unittest.main()
