import { useReviewStore, type ReviewItem } from "@/stores/review-store"
import { useLintStore } from "@/stores/lint-store"
import { useChatStore } from "@/stores/chat-store"
import { useWikiStore } from "@/stores/wiki-store"
import { loadReviewItems, saveReviewItems, saveLintItems, saveChatHistory, saveChatPreferences } from "./persist"

let reviewTimer: ReturnType<typeof setTimeout> | null = null
let lintTimer: ReturnType<typeof setTimeout> | null = null
let chatTimer: ReturnType<typeof setTimeout> | null = null

// While suspended, the store subscriptions skip writing. This is essential
// during a project switch: resetProjectState() clears every store to empty,
// and without this guard the debounced callbacks would persist those empty
// arrays back to the OUTGOING project's .llm-wiki/*.json — wiping its pending
// review / deep-research items. The switch flow flushes real data to disk via
// flushAndSuspendAutoSave() first, then resumes once the new project loads.
let suspended = false

// The project whose saved review items have loaded. Project open resumes
// auto-save before it reads them, so until then the review store holds only
// what arrived since the switch (a merge-queue time-out notice, say), and
// saving that would write it alone over the project's review.json (#62).
let reviewLoadedFor: string | null = null

function clearTimers(): void {
  if (reviewTimer) { clearTimeout(reviewTimer); reviewTimer = null }
  if (lintTimer) { clearTimeout(lintTimer); lintTimer = null }
  if (chatTimer) { clearTimeout(chatTimer); chatTimer = null }
}

/**
 * Immediately persist the current stores to the current project, then stop
 * auto-save from firing until resumeAutoSave() is called. Must be invoked
 * before resetProjectState() clears the stores on a project switch.
 */
export async function flushAndSuspendAutoSave(): Promise<void> {
  suspended = true
  clearTimers()
  const reviewLoaded = reviewLoadedFor
  reviewLoadedFor = null
  const projectPath = useWikiStore.getState().project?.path
  if (!projectPath) return
  const review = useReviewStore.getState().items
  const lint = useLintStore.getState().items
  const chat = useChatStore.getState()
  await Promise.allSettled([
    reviewLoaded === projectPath ? saveReviewItems(projectPath, review) : Promise.resolve(),
    saveLintItems(projectPath, lint),
    saveChatPreferences(projectPath, {
      useWebSearch: chat.useWebSearch,
      useAnyTxtSearch: chat.useAnyTxtSearch,
      agentMode: chat.agentMode,
      retrievalMode: chat.retrievalMode,
      selectedSkills: chat.selectedSkills,
      disabledSkills: chat.disabledSkills,
    }),
    chat.isStreaming
      ? Promise.resolve()
      : saveChatHistory(projectPath, chat.conversations, chat.messages),
  ])
}

export function resumeAutoSave(): void {
  suspended = false
}

/**
 * Run a project-switch/open operation while auto-save is suspended. If the
 * operation fails, onFailure runs before auto-save resumes so callers can clear
 * any half-loaded project path before store changes are allowed to persist.
 */
export async function runWithSuspendedAutoSave<T>(
  action: () => Promise<T>,
  onFailure?: () => void,
): Promise<T> {
  await flushAndSuspendAutoSave()
  try {
    return await action()
  } catch (err) {
    try {
      onFailure?.()
    } catch (cleanupErr) {
      console.warn("Failed to clean up after suspended auto-save operation:", cleanupErr)
    }
    throw err
  } finally {
    resumeAutoSave()
  }
}

/**
 * Load a project's saved review items into the review store and let the
 * review auto-save write for that project from then on. Items that arrived
 * while the file was loading are kept beside them. One with the same id as
 * a saved item is merged with it by the store's rule, so a resolved item
 * stays resolved, except an arrived `reopenedId`, which replaces the saved
 * one: the merge-queue restore files its time-out notice open on purpose.
 * When there are no saved items, the arrivals are saved at once, since the
 * store does not change to set off the auto-save.
 *
 * Returns whether the store took the saved items. It does nothing once
 * `stillCurrent` says the project has changed. While a switch has auto-save
 * suspended it does nothing even for the same project, since the switch's
 * own open loads them again.
 */
export async function loadSavedReviewItems(
  projectPath: string,
  stillCurrent: () => boolean,
  reopenedId?: string,
): Promise<boolean> {
  const saved = await loadReviewItems(projectPath)
  if (suspended || !stillCurrent()) return false
  reviewLoadedFor = projectPath
  const { items, setItems } = useReviewStore.getState()
  if (saved.length === 0) {
    if (items.length > 0) scheduleReviewSave(projectPath, items)
    return false
  }
  const reopened = items.some((item) => item.id === reopenedId)
  setItems([...saved.filter((item) => !reopened || item.id !== reopenedId), ...items])
  return true
}

/**
 * Project open's review load. The merge-queue module is imported first, in
 * its own catch, so the review auto-save opens for the project even if the
 * import fails, and nothing awaits between the load and the dismissal of a
 * time-out notice the queue's opening has made stale (#59, #65).
 */
export async function loadReviewItemsOnOpen(
  projectId: string,
  projectPath: string,
  stillCurrent: () => boolean,
): Promise<void> {
  let dedupQueue: typeof import("./dedup-queue") | null = null
  try {
    dedupQueue = await import("./dedup-queue")
  } catch (err) {
    console.warn("[startup] failed to load the merge queue module:", err)
  }
  const tookSavedItems = await loadSavedReviewItems(
    projectPath,
    stillCurrent,
    dedupQueue?.RESTORE_TIMEOUT_NOTICE_ID,
  )
  if (tookSavedItems) dedupQueue?.dismissStaleRestoreNotice(projectId)
}

function scheduleReviewSave(projectPath: string, items: ReviewItem[]): void {
  if (reviewTimer) clearTimeout(reviewTimer)
  reviewTimer = setTimeout(() => {
    saveReviewItems(projectPath, items).catch(() => {})
  }, 1000)
}

export function setupAutoSave(): void {
  // Auto-save review items (debounced 1s)
  useReviewStore.subscribe((state) => {
    if (suspended) return
    const projectPath = useWikiStore.getState().project?.path
    if (!projectPath || projectPath !== reviewLoadedFor) return
    scheduleReviewSave(projectPath, state.items)
  })

  // Auto-save lint items (debounced 1s)
  useLintStore.subscribe((state) => {
    if (suspended) return
    const projectPath = useWikiStore.getState().project?.path
    if (lintTimer) clearTimeout(lintTimer)
    lintTimer = setTimeout(() => {
      if (projectPath) {
        saveLintItems(projectPath, state.items).catch(() => {})
      }
    }, 1000)
  })

  // Auto-save chat conversations and messages (debounced 2s, skip during streaming)
  useChatStore.subscribe((state) => {
    if (suspended) return
    if (state.isStreaming) return
    const projectPath = useWikiStore.getState().project?.path
    if (chatTimer) clearTimeout(chatTimer)
    chatTimer = setTimeout(() => {
      if (projectPath) {
        Promise.allSettled([
          saveChatPreferences(projectPath, {
            useWebSearch: state.useWebSearch,
            useAnyTxtSearch: state.useAnyTxtSearch,
            agentMode: state.agentMode,
            retrievalMode: state.retrievalMode,
            selectedSkills: state.selectedSkills,
            disabledSkills: state.disabledSkills,
          }),
          saveChatHistory(projectPath, state.conversations, state.messages),
        ]).catch(() => {})
      }
    }, 2000)
  })
}
