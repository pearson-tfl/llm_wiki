/**
 * Shared by the gated live previews of the scheduled run (#111): the vault
 * copy they may touch, and the store loaded from app-state the way the app
 * loads it.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  useWikiStore,
  type CustomLlmPreset,
  type EmbeddingConfig,
  type LlmConfig,
  type ProviderConfigs,
  type ProxyConfig,
  type TaskModelRoutingConfig,
} from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

/** The app-state fields the scheduled run's route is resolved from. */
export interface SavedAppState {
  llmConfig: LlmConfig
  providerConfigs?: ProviderConfigs
  customLlmPresets?: CustomLlmPreset[]
  taskModelRouting: TaskModelRoutingConfig
  proxyConfig: ProxyConfig
  embeddingConfig: EmbeddingConfig
}

/**
 * The copy's real path. Throws unless it lies under the OS temp folder once
 * links are resolved, so a link to a live vault is refused, and throws when
 * the path cannot be read.
 */
export async function tempVaultCopy(given: string): Promise<string> {
  const vault = await fs.realpath(path.resolve(given))
  const roots = await Promise.all([os.tmpdir(), "/tmp"].map((root) => fs.realpath(root)))
  if (!roots.some((root) => vault.startsWith(`${root}/`))) {
    throw new Error(`${given} is not a copy under the OS temp folder`)
  }
  return vault
}

/** Open the project with the saved route; no project override is saved. */
export function seedStoreFromAppState(state: SavedAppState, project: WikiProject): void {
  useWikiStore.setState({
    project,
    llmConfig: state.llmConfig,
    providerConfigs: state.providerConfigs ?? {},
    customLlmPresets: state.customLlmPresets ?? [],
    taskModelRouting: state.taskModelRouting,
    projectLlmOverride: { enabled: false, presetId: null, model: "" },
    proxyConfig: state.proxyConfig,
    embeddingConfig: state.embeddingConfig,
  })
}

/** Minutes since `start`, to one decimal place. */
export function minutesSince(start: number): number {
  return Math.round((Date.now() - start) / 60_000 * 10) / 10
}
