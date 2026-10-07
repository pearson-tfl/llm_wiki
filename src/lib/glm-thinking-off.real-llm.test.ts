/**
 * Reasoning "off" turns thinking off on the scheduled run's route
 * (pearson-tfl/llm_wiki#134): the store loaded from app-state field by field,
 * as #111's preview does, getTaskLlmConfig("ingest") resolving the route as
 * the tick does, and the app's own request for it – getProviderConfig's URL,
 * headers and body, with the ingest reasoning – sent once with "off" and once
 * with "auto". The reply's content blocks are read from the non-streaming
 * JSON, so a thinking block cannot hide in a stream parser.
 *
 * The "auto" call is the control: it is expected to think, which shows the
 * "off" reply has no thinking block because of the field, not because the
 * model happened not to think. If the control stops thinking, the run proves
 * nothing about the fix.
 *
 * Gated behind RUN_LLM_TESTS=1 and one of two route sources, each only read,
 * its key never leaving this process:
 * - APP_STATE, the app-state.json (on the Mac,
 *   ~/Library/Application Support/com.llmwiki.app/app-state.json);
 * - GLM_ROUTE, a route file holding provider, apiMode, baseUrl, model,
 *   maxContextSize and apiKey (on the Dell, ~/.config/llm-wiki/glm-route.json),
 *   which stands for an app-state whose only route is that one.
 * Skips when the ingest route is not a custom Anthropic-messages one. api.z.ai is slow to
 * connect over IPv6 from the Mac (#111); run it with
 * NODE_OPTIONS="--dns-result-order=ipv4first
 * --network-family-autoselection-attempt-timeout=5000".
 */
import { describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import { useWikiStore, type LlmConfig, type ReasoningConfig } from "@/stores/wiki-store"

const ENABLED =
  process.env.RUN_LLM_TESTS === "1" && (!!process.env.APP_STATE || !!process.env.GLM_ROUTE)

const PROMPT = "A train leaves at 09:47 and arrives at 13:12. How long is the journey? Answer in one line."

async function ingestRoute(): Promise<LlmConfig> {
  if (process.env.APP_STATE) {
    // The fields the app loads at start-up, as they are in app-state.
    const state = JSON.parse(await fs.readFile(process.env.APP_STATE, "utf8"))
    useWikiStore.setState({
      llmConfig: state.llmConfig,
      providerConfigs: state.providerConfigs ?? {},
      customLlmPresets: state.customLlmPresets ?? [],
      ...(state.taskModelRouting ? { taskModelRouting: state.taskModelRouting } : {}),
      projectLlmOverride: { enabled: false, presetId: null, model: "" },
      proxyConfig: state.proxyConfig,
    })
  } else {
    const file = JSON.parse(await fs.readFile(process.env.GLM_ROUTE ?? "", "utf8"))
    useWikiStore.setState({
      llmConfig: {
        ...useWikiStore.getState().llmConfig,
        provider: file.provider,
        apiMode: file.apiMode,
        customEndpoint: file.baseUrl,
        model: file.model,
        maxContextSize: file.maxContextSize,
        apiKey: file.apiKey,
      },
      projectLlmOverride: { enabled: false, presetId: null, model: "" },
    })
  }
  const { getTaskLlmConfig } = await import("./llm-task-routing")
  return getTaskLlmConfig("ingest")
}

async function call(config: LlmConfig, reasoning: ReasoningConfig) {
  const { getProviderConfig } = await import("./llm-providers")
  const provider = getProviderConfig({ ...config, streamingEnabled: false })
  const body = provider.buildBody(
    [{ role: "user", content: PROMPT }],
    { reasoning, max_tokens: 2048 },
  ) as Record<string, unknown>
  const response = await fetch(provider.url, {
    method: "POST",
    headers: provider.headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`endpoint answered ${response.status}: ${text.slice(0, 300)}`)
  const reply = JSON.parse(text) as {
    content?: { type: string; text?: string; thinking?: string }[]
    usage?: { output_tokens?: number }
  }
  const blocks = (reply.content ?? []).map((b) => ({
    type: b.type,
    chars: (b.thinking ?? b.text ?? "").length,
  }))
  const result = { sentThinking: body.thinking ?? null, blocks, outputTokens: reply.usage?.output_tokens }
  console.log(JSON.stringify({ reasoning: reasoning.mode, ...result }))
  return result
}

describe.skipIf(!ENABLED)("reasoning off on the scheduled run's route (#134)", () => {
  it("sends thinking disabled, and the reply holds no thinking block", async (ctx) => {
    const config = await ingestRoute()
    const { resolveIngestReasoning } = await import("./reasoning-capabilities")
    const { hasUsableLlm } = await import("./has-usable-llm")
    const route = {
      provider: config.provider,
      model: config.model,
      endpoint: config.customEndpoint,
      apiMode: config.apiMode,
      ingestReasoning: resolveIngestReasoning(config),
      usable: hasUsableLlm(config),
    }
    console.log(JSON.stringify({ route }))
    if (config.provider !== "custom" || config.apiMode !== "anthropic_messages") {
      ctx.skip("the ingest route is not a custom Anthropic-messages route")
    }
    expect(route.usable).toBe(true)
    expect(route.ingestReasoning).toEqual({ mode: "off" })

    const off = await call(config, route.ingestReasoning)
    expect(off.sentThinking).toEqual({ type: "disabled" })
    expect(off.blocks.some((b) => b.type === "text" && b.chars > 0)).toBe(true)
    expect(off.blocks.filter((b) => b.type === "thinking" || b.type === "redacted_thinking")).toEqual([])

    const auto = await call(config, { mode: "auto" })
    expect(auto.sentThinking).toBeNull()
    expect(auto.blocks.some((b) => b.type === "thinking"), "the control call did not think").toBe(true)
  }, 180_000)
})
