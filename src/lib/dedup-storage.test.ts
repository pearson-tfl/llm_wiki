/**
 * The saved duplicate groups (#117, #120), against a real temporary
 * project: the scheduled run adding or replacing groups and the
 * Maintenance screen dropping one, all read-modify-writes of the same file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createDeferred } from "@/test-helpers/deferred"

vi.mock("@/commands/fs", () => ({ ...realFs, readFile: vi.fn(realFs.readFile) }))

import { readFile } from "@/commands/fs"
import {
  addNotDuplicate,
  addPendingDuplicateGroups,
  listWikiPages,
  loadPendingDuplicateGroups,
  readNotDuplicates,
  recordNotDuplicates,
  removePendingDuplicateGroup,
  replacePendingDuplicateGroups,
  savePendingDuplicateGroups,
} from "./dedup-storage"
import { loadAllWikiPages } from "./dedup-runner"
import type { DuplicateGroup } from "./dedup"

let tmp: { path: string; cleanup: () => Promise<void> }

function group(slugs: string[]): DuplicateGroup {
  return { slugs, confidence: "medium", reason: "same topic" }
}

beforeEach(async () => {
  tmp = await createTempProject("dedup-storage")
})

afterEach(async () => {
  vi.mocked(readFile).mockImplementation(realFs.readFile)
  await tmp.cleanup()
})

async function writePages(...paths: string[]) {
  for (const path of paths) await writeFileRaw(`${tmp.path}/${path}`, "# page\n")
}

describe("saved duplicate groups", () => {
  it("keeps both writes when the scheduled run adds groups while the Maintenance screen drops one", async () => {
    const acted = group(["pstack", "p-stack"])
    const left = group(["seat", "lane"])
    await writePages("wiki/concepts/seat.md", "wiki/concepts/lane.md")
    await savePendingDuplicateGroups(tmp.path, [acted, left])
    const added = group(["concepts/agent-skills", "entities/agent-skills"])

    await Promise.all([
      addPendingDuplicateGroups(tmp.path, [added]),
      removePendingDuplicateGroup(tmp.path, ["P-Stack", "pstack"]),
    ])

    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([left, added])
  })

  it("does not let a Maintenance-screen drop that read the old list write it back over a done scan's list (#120)", async () => {
    const acted = group(["pstack", "p-stack"])
    const left = group(["seat", "lane"])
    await savePendingDuplicateGroups(tmp.path, [acted, left])
    const fresh = group(["hook", "hooks"])
    // The drop reads the old list, then is held before it writes.
    const held = createDeferred()
    vi.mocked(readFile).mockImplementationOnce(async (path) => {
      const content = await realFs.readFile(path)
      await held.promise
      return content
    })

    const dropped = removePendingDuplicateGroup(tmp.path, ["pstack", "p-stack"])
    const replaced = replacePendingDuplicateGroups(tmp.path, [fresh])
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The done scan's write waits for the drop's.
    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([acted, left])
    held.resolve()
    await Promise.all([dropped, replaced])

    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([fresh])
  })

  it("drops a saved group naming a page no longer on disk, or a slug naming two pages, when groups are added (#120, #135)", async () => {
    await writePages(
      "wiki/concepts/seat.md",
      "wiki/concepts/lane.md",
      "wiki/concepts/agent-skills.md",
      "wiki/entities/agent-skills.md",
      "wiki/entities/skills.md",
      "wiki/concepts/hook.md",
    )
    const live = group(["seat", "lane"])
    // Its slug names two pages, which a merge refuses; the scan that finds
    // it again settles it by judgement (#135).
    const ambiguous = group(["agent-skills", "skills"])
    const merged = group(["pstack", "p-stack"])
    const halfGone = group(["hook", "hooks"])
    const byPageId = group(["concepts/agent-skills", "entities/agent-skills"])
    const deletedById = group(["concepts/relay", "entities/relay"])
    await savePendingDuplicateGroups(tmp.path, [live, ambiguous, merged, halfGone, byPageId, deletedById])
    const added = group(["concepts/lane", "entities/lane"])

    await addPendingDuplicateGroups(tmp.path, [added])

    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([live, byPageId, added])
  })
})

describe("the not-duplicates list", () => {
  const listPath = () => `${tmp.path}/.llm-wiki/dedup-not-duplicates.json`

  it("records the judge's pairs sorted, leaving out one already there in any casing (#135)", async () => {
    await addNotDuplicate(tmp.path, ["hooks", "hook"])
    await recordNotDuplicates(tmp.path, [
      ["entities/agent-skills", "concepts/agent-skills"],
      ["Hook", "HOOKS"],
    ])

    expect(await readNotDuplicates(tmp.path)).toEqual([
      ["hook", "hooks"],
      ["concepts/agent-skills", "entities/agent-skills"],
    ])
  })

  it("refuses to record into a list it cannot read, leaving the file as it was (#135)", async () => {
    await writeFileRaw(listPath(), "[[\"hook\", \"hooks\"]")

    await expect(recordNotDuplicates(tmp.path, [["concepts/a", "entities/a"]]))
      .rejects.toThrow("Cannot read the not-duplicates list")
    expect(await realFs.readFile(listPath())).toBe("[[\"hook\", \"hooks\"]")
  })

  it("keeps both writes when the scan records a verdict while the Maintenance screen adds a pair (#135)", async () => {
    await addNotDuplicate(tmp.path, ["seat", "lane"])
    // The screen's add reads the old list, then is held before it writes.
    const held = createDeferred()
    vi.mocked(readFile).mockImplementationOnce(async (path) => {
      const content = await realFs.readFile(path)
      await held.promise
      return content
    })

    const added = addNotDuplicate(tmp.path, ["hook", "hooks"])
    const recorded = recordNotDuplicates(tmp.path, [["concepts/a", "entities/a"]])
    await new Promise((resolve) => setTimeout(resolve, 50))
    held.resolve()
    await Promise.all([added, recorded])

    expect(await readNotDuplicates(tmp.path)).toEqual([
      ["lane", "seat"],
      ["hook", "hooks"],
      ["concepts/a", "entities/a"],
    ])
  })
})

describe("listWikiPages", () => {
  it("names pages as the merge's page read does, for a project path ending in a slash (#126)", async () => {
    await writePages("wiki/concepts/seat.md", "wiki/entities/lane.md")
    const pp = `${tmp.path}/`

    const listed = (await listWikiPages(pp)).map((p) => p.path).sort()

    expect(listed).toEqual((await loadAllWikiPages(pp)).map((p) => p.path).sort())
  })
})
