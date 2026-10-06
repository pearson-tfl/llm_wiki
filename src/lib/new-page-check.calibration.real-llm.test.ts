/**
 * Calibration run for the new-page check's threshold (#69): scores labelled
 * page pairs from a real wiki with a real embedding endpoint, through the
 * check's own summary text and cosine, and prints precision and recall per
 * threshold. The chosen value and its table are in ESTATE.md.
 *
 * Opt-in: needs CALIBRATE_WIKI (a wiki project folder holding the pages
 * below, e.g. the Agent Harness Wiki vault), EMBEDDING_ENDPOINT and
 * EMBEDDING_MODEL. Run:
 *   CALIBRATE_WIKI=<project> EMBEDDING_ENDPOINT=http://127.0.0.1:11434/v1/embeddings \
 *   EMBEDDING_MODEL=qwen3-embedding:0.6b npx vitest run new-page-check.calibration --reporter=verbose
 */
import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"

// The app posts { model, input } from Rust; under Node the same body goes
// straight to the endpoint.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { text?: string; cfg?: { endpoint: string; model: string } }) => {
    if (cmd !== "embedding_fetch" || !args?.cfg) throw new Error(`unexpected command ${cmd}`)
    const response = await fetch(args.cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: args.cfg.model, input: args.text }),
    })
    if (!response.ok) throw new Error(`embedding endpoint answered ${response.status}`)
    return (await response.json()).data[0].embedding
  },
}))

import { cosineSimilarity } from "./dedup_embedding"
import { fetchEmbedding } from "./embedding"
import { NEAR_DUPLICATE_THRESHOLD, summaryText } from "./new-page-check"

const WIKI = process.env.CALIBRATE_WIKI ?? ""
const ENABLED = !!WIKI && !!process.env.EMBEDDING_ENDPOINT && !!process.env.EMBEDDING_MODEL

// Labelled by reading both pages. Twins: the same subject under two pages.
const TWINS = [
  "entities/claude-3-7-sonnet|entities/claude-sonnet-3-7",
  "entities/openclaw-cli-backend|entities/openclaw-cli-backends",
  "entities/openclaw-code-mode-executor|entities/openclaw-code-mode-executors",
  "entities/openclaw-embedding-provider|entities/openclaw-embedding-providers",
  "entities/openclaw-secretref|entities/openclaw-secretrefs",
  "concepts/agent-skills|entities/agent-skills",
  "concepts/openclaw-dreaming|entities/openclaw-dreaming",
  "concepts/openclaw-code-mode|entities/openclaw-code-mode",
  "entities/openclaw-compaction-provider|entities/openclaw-compaction-provider-api",
  "entities/openclaw-model-catalog-provider|entities/openclaw-model-catalog-provider-api",
]
// Distinct subjects whose names share words. The first four were listed as
// surface twins but name different things: DeepSeek harness's todo_write and
// Claude Code's TodoWrite; `openclaw agent` and `openclaw agents`; the
// agent.wait RPC and the agents_wait tool; `openclaw node` and `openclaw nodes`.
const DISTINCT = [
  "entities/todo-write|entities/todowrite",
  "entities/openclaw-agent-cli|entities/openclaw-agents-cli",
  "entities/openclaw-agent-wait|entities/openclaw-agents-wait",
  "entities/openclaw-node-cli|entities/openclaw-nodes-cli",
  "entities/gpt-4-1|entities/gpt-4-1-mini",
  "entities/gpt-3-5-turbo|entities/gpt-3-5-turbo-16k",
  "entities/claude-opus-4|entities/claude-opus-4-6",
  "entities/claude-sonnet-4|entities/claude-sonnet-4-6",
  "entities/glm-5|entities/glm-5-3",
  "entities/mpt-30b|entities/mpt-30b-instruct",
  "entities/big-bench|entities/big-bench-lite",
  "entities/swe-bench|entities/swe-bench-verified",
  "entities/codex-app-server|entities/codex-app-server-harness",
  "entities/openclaw-gateway|entities/openclaw-gateway-lock",
  "entities/openclaw-gateway|entities/openclaw-gateway-rate-limiters",
  "entities/openclaw-sessions|entities/openclaw-sessions-search",
  "entities/openclaw-sandbox|entities/openclaw-sandbox-fs-bridge",
  "entities/openclaw-update|entities/openclaw-update-run-ledger",
  "entities/openclaw-browser-cli|entities/openclaw-sandbox-cli",
  "entities/openclaw-skills-cli|entities/openclaw-plugins-cli",
  "concepts/agent-harness|concepts/agent-harness-selection-policy",
  "concepts/agent-loop|concepts/agent-loop-execution-patterns",
  "concepts/benchmark-contamination|concepts/benchmark-contamination-canaries",
  "concepts/memory-audience|concepts/memory-audience-inheritance",
  "concepts/knowledge-promotion|concepts/knowledge-promotion-destinations",
]

describe.skipIf(!ENABLED)("new-page check threshold calibration", () => {
  it("prints precision and recall per threshold over the labelled pairs", async () => {
    const cfg = {
      enabled: true,
      endpoint: process.env.EMBEDDING_ENDPOINT ?? "",
      apiKey: "",
      model: process.env.EMBEDDING_MODEL ?? "",
    }
    const vectors = new Map<string, number[]>()
    const vectorOf = async (page: string) => {
      let vector = vectors.get(page)
      if (!vector) {
        const path = `wiki/${page}.md`
        const embedded = await fetchEmbedding(summaryText(path, await fs.readFile(`${WIKI}/${path}`, "utf8")), cfg)
        if (!embedded) throw new Error(`no embedding for ${path}`)
        vector = embedded
        vectors.set(page, vector)
      }
      return vector
    }
    const score = async (pair: string) => {
      const [a, b] = pair.split("|")
      return Math.round(cosineSimilarity(await vectorOf(a), await vectorOf(b)) * 1000) / 1000
    }
    const twins = await Promise.all(TWINS.map(async (pair) => ({ pair, score: await score(pair) })))
    const distinct = await Promise.all(DISTINCT.map(async (pair) => ({ pair, score: await score(pair) })))

    const lines = ["| Pair | Label | Score |", "|---|---|---|"]
    for (const { pair, score } of twins) lines.push(`| ${pair} | twin | ${score.toFixed(3)} |`)
    for (const { pair, score } of distinct) lines.push(`| ${pair} | distinct | ${score.toFixed(3)} |`)
    lines.push("", "| Threshold | Flagged twins | Flagged distinct | Precision | Recall |", "|---|---|---|---|---|")
    for (let step = 70; step <= 95; step++) {
      const threshold = step / 100
      const tp = twins.filter((pair) => pair.score >= threshold).length
      const fp = distinct.filter((pair) => pair.score >= threshold).length
      const precision = tp + fp === 0 ? "–" : (tp / (tp + fp)).toFixed(2)
      lines.push(`| ${threshold.toFixed(2)} | ${tp}/${twins.length} | ${fp}/${distinct.length} | ${precision} | ${(tp / twins.length).toFixed(2)} |`)
    }
    console.log(lines.join("\n"))

    const flagged = [...twins, ...distinct].filter((pair) => pair.score >= NEAR_DUPLICATE_THRESHOLD)
    console.log(`At the chosen ${NEAR_DUPLICATE_THRESHOLD}: ${flagged.map((pair) => pair.pair).join(", ")}`)
    expect([...twins, ...distinct].every((pair) => pair.score > 0 && pair.score <= 1)).toBe(true)
  }, 120_000)
})
