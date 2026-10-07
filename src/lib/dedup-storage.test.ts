/**
 * The saved duplicate groups (#117), against a real temporary project: the
 * scheduled run adding groups and the Maintenance screen dropping one,
 * both read-modify-writes of the same file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, realFs } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import {
  addPendingDuplicateGroups,
  loadPendingDuplicateGroups,
  removePendingDuplicateGroup,
  savePendingDuplicateGroups,
} from "./dedup-storage"
import type { DuplicateGroup } from "./dedup"

let tmp: { path: string; cleanup: () => Promise<void> }

function group(slugs: string[]): DuplicateGroup {
  return { slugs, confidence: "medium", reason: "same topic" }
}

beforeEach(async () => {
  tmp = await createTempProject("dedup-storage")
})

afterEach(async () => {
  await tmp.cleanup()
})

describe("saved duplicate groups", () => {
  it("keeps both writes when the scheduled run adds groups while the Maintenance screen drops one", async () => {
    const acted = group(["pstack", "p-stack"])
    const left = group(["seat", "lane"])
    await savePendingDuplicateGroups(tmp.path, [acted, left])
    const added = group(["concepts/agent-skills", "entities/agent-skills"])

    await Promise.all([
      addPendingDuplicateGroups(tmp.path, [added]),
      removePendingDuplicateGroup(tmp.path, ["P-Stack", "pstack"]),
    ])

    expect(await loadPendingDuplicateGroups(tmp.path)).toEqual([left, added])
  })
})
