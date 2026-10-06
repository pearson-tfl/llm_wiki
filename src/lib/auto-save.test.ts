/**
 * Regression test for the project-switch data-loss bug:
 *
 * When switching wiki projects, resetProjectState() empties the review/lint/chat
 * stores. The auto-save subscriptions are debounced, so without a guard their
 * timers fired AFTER the store was cleared but while project?.path still pointed
 * at the OUTGOING project — persisting empty arrays over that project's pending
 * review / deep-research items. Switching back then loaded an emptied review.json.
 *
 * flushAndSuspendAutoSave() must (1) persist the real current state to disk and
 * (2) suspend the subscriptions so the subsequent clear-to-empty does not write.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const { loadReviewItems, saveReviewItems, saveLintItems, saveChatHistory, saveChatPreferences } = vi.hoisted(() => ({
  loadReviewItems: vi.fn().mockResolvedValue([]),
  saveReviewItems: vi.fn().mockResolvedValue(undefined),
  saveLintItems: vi.fn().mockResolvedValue(undefined),
  saveChatHistory: vi.fn().mockResolvedValue(undefined),
  saveChatPreferences: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("./persist", () => ({ loadReviewItems, saveReviewItems, saveLintItems, saveChatHistory, saveChatPreferences }))

import {
  setupAutoSave,
  flushAndSuspendAutoSave,
  resumeAutoSave,
  runWithSuspendedAutoSave,
  loadSavedReviewItems,
} from "./auto-save"
import { useReviewStore } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { ReviewItem } from "@/stores/review-store"

function setProjectPath(path: string | null): void {
  useWikiStore.setState({ project: path ? ({ id: "p", name: "p", path } as never) : null })
}

/** Set the project and load its saved review items, as project open does,
 *  so the review auto-save writes for it (#62). */
async function openProject(path: string): Promise<void> {
  setProjectPath(path)
  await loadSavedReviewItems(path, () => true)
}

function review(id: string): ReviewItem {
  return { id, type: "missing-page", title: id, description: "", options: [], resolved: false, createdAt: 0 }
}

let registered = false

beforeEach(async () => {
  // A flush with no project open clears which project's review items have
  // loaded, without writing.
  setProjectPath(null)
  await flushAndSuspendAutoSave()
  saveReviewItems.mockClear()
  saveLintItems.mockClear()
  saveChatHistory.mockClear()
  saveChatPreferences.mockClear()
  useReviewStore.setState({ items: [] })
  useLintStore.setState({ items: [] })
  useChatStore.setState({ conversations: [], messages: [], isStreaming: false })
  resumeAutoSave()
  vi.useFakeTimers()
  // setupAutoSave registers permanent subscriptions; only do it once.
  if (!registered) {
    setupAutoSave()
    registered = true
  }
})

describe("auto-save project-switch guard", () => {
  it("flushes current review state to the outgoing project before suspend", async () => {
    await openProject("/proj/A")
    useReviewStore.setState({ items: [review("a1"), review("a2")] })

    await flushAndSuspendAutoSave()

    expect(saveReviewItems).toHaveBeenCalledWith("/proj/A", [review("a1"), review("a2")])
  })

  it("does NOT persist the empty store after suspend (the data-loss bug)", async () => {
    await openProject("/proj/A")
    useReviewStore.setState({ items: [review("a1")] })

    await flushAndSuspendAutoSave()
    saveReviewItems.mockClear()
    saveLintItems.mockClear()

    // resetProjectState would do this — clear stores while path is still A.
    useReviewStore.setState({ items: [] })
    useLintStore.setState({ items: [] })
    vi.runAllTimers()

    expect(saveReviewItems).not.toHaveBeenCalled()
    expect(saveLintItems).not.toHaveBeenCalled()
  })

  it("resumes persisting after resumeAutoSave", async () => {
    setProjectPath("/proj/B")
    flushAndSuspendAutoSave()
    resumeAutoSave()
    await openProject("/proj/B")

    useReviewStore.setState({ items: [review("b1")] })
    vi.runAllTimers()

    expect(saveReviewItems).toHaveBeenCalledWith("/proj/B", [review("b1")])
  })

  it("runs the failure cleanup before resuming auto-save", async () => {
    await openProject("/proj/A")
    useReviewStore.setState({ items: [review("a1")] })

    await expect(runWithSuspendedAutoSave(
      async () => {
        throw new Error("open failed")
      },
      () => {
        // This store mutation must still be suppressed. If the helper resumed
        // auto-save before running cleanup, it would schedule an empty write
        // using the old project path captured before setProjectPath(null).
        useReviewStore.setState({ items: [] })
        setProjectPath(null)
      },
    )).rejects.toThrow("open failed")

    saveReviewItems.mockClear()
    saveLintItems.mockClear()
    saveChatHistory.mockClear()
    saveChatPreferences.mockClear()

    // A post-failure store change should not write empty data to the half-opened
    // project because the cleanup cleared the active project before resume.
    useReviewStore.setState({ items: [] })
    useLintStore.setState({ items: [] })
    useChatStore.setState({ conversations: [], messages: [] })
    vi.runAllTimers()

    expect(saveReviewItems).not.toHaveBeenCalled()
    expect(saveLintItems).not.toHaveBeenCalled()
    expect(saveChatHistory).not.toHaveBeenCalled()
    expect(saveChatPreferences).not.toHaveBeenCalled()
  })

  it("a review load that lands after its project changed neither fills the store nor lets the review auto-save write", async () => {
    setProjectPath("/proj/A")
    loadReviewItems.mockResolvedValueOnce([review("a1")])

    expect(await loadSavedReviewItems("/proj/A", () => false)).toBe(false)
    expect(useReviewStore.getState().items).toEqual([])

    useReviewStore.setState({ items: [review("a2")] })
    vi.runAllTimers()
    expect(saveReviewItems).not.toHaveBeenCalled()
  })

  it("a review load keeps the items that arrived while it read, and a saved resolved item with the same id stays resolved (#65)", async () => {
    setProjectPath("/proj/A")
    loadReviewItems.mockResolvedValueOnce([{ ...review("n1"), resolved: true }, review("a1")])
    useReviewStore.setState({ items: [review("n1"), review("n2")] })

    expect(await loadSavedReviewItems("/proj/A", () => true)).toBe(true)

    expect(useReviewStore.getState().items.map(({ title, resolved }) => ({ title, resolved }))).toEqual([
      { title: "n1", resolved: true },
      { title: "a1", resolved: false },
      { title: "n2", resolved: false },
    ])
  })

  it("skips chat flush while streaming", async () => {
    await openProject("/proj/A")
    useChatStore.setState({ isStreaming: true })

    await flushAndSuspendAutoSave()

    expect(saveChatHistory).not.toHaveBeenCalled()
    expect(saveChatPreferences).toHaveBeenCalledWith("/proj/A", {
      useWebSearch: false,
      useAnyTxtSearch: false,
      agentMode: "standard",
      retrievalMode: "standard",
      selectedSkills: [],
      disabledSkills: [],
    })
    expect(saveReviewItems).toHaveBeenCalled()
  })

  it("persists chat search preferences on flush", async () => {
    setProjectPath("/proj/A")
    useChatStore.setState({
      useWebSearch: true,
      useAnyTxtSearch: true,
      agentMode: "local_first",
      retrievalMode: "smart",
      selectedSkills: ["reviewer"],
      disabledSkills: [],
    })

    await flushAndSuspendAutoSave()

    expect(saveChatPreferences).toHaveBeenCalledWith("/proj/A", {
      useWebSearch: true,
      useAnyTxtSearch: true,
      agentMode: "local_first",
      retrievalMode: "smart",
      selectedSkills: ["reviewer"],
      disabledSkills: [],
    })
  })
})
