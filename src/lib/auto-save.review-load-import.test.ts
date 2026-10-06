/**
 * Project open's review load when the merge-queue module fails to import
 * (#65): the saved review items still load, and the review auto-save
 * still writes for the project afterwards.
 *
 * Real auto-save, save and load code on a real temp folder; only the
 * clock is fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { flushIO } from "@/test-helpers/deferred"
import { createTempProject, readFileRaw, writeFileRaw } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", async () => (await import("@/test-helpers/fs-temp")).realFs)

vi.mock("./dedup-queue", () => {
  throw new Error("the merge-queue module did not load")
})

import { setupAutoSave, runWithSuspendedAutoSave, loadReviewItemsOnOpen } from "./auto-save"
import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"

const SAVED: ReviewItem[] = [
  { id: "review-saved", type: "missing-page", title: "Saved review", description: "", options: [], resolved: false, createdAt: 1 },
]
const SAVED_FILE = JSON.stringify(SAVED, null, 2)

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  vi.spyOn(console, "warn").mockImplementation(() => {})
  tmp = await createTempProject("review-load-import")
  await writeFileRaw(`${tmp.path}/.llm-wiki/review.json`, SAVED_FILE)
  setupAutoSave()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await tmp.cleanup()
})

describe("project open's review load with the merge-queue module failing to import (#65)", () => {
  it("loads the saved review items and lets the review auto-save write", async () => {
    const project = { id: "project-id", name: "P", path: tmp.path }
    const isOpen = () => useWikiStore.getState().project?.id === project.id
    await runWithSuspendedAutoSave(async () => {
      useReviewStore.setState({ items: [] })
      useWikiStore.setState({ project: project as never })
    })

    await loadReviewItemsOnOpen(project.id, project.path, isOpen)
    expect(console.warn).toHaveBeenCalledWith("[startup] failed to load the merge queue module:", expect.any(Error))
    expect(useReviewStore.getState().items.map((i) => i.title)).toEqual(["Saved review"])

    useReviewStore.getState().addItem({ type: "suggestion", title: "Arrived later", description: "", options: [] })
    await vi.advanceTimersByTimeAsync(1_000)
    await flushIO(50)
    const written = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/review.json`)) as ReviewItem[]
    expect(written.map((i) => i.title)).toEqual(["Saved review", "Arrived later"])
  })
})
