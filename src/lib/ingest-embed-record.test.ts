/**
 * #73: an ingest writes the embedded-pages record once for every page it
 * embedded, not once per page. Runs the real `autoIngest` and `embedPage`
 * against a real temporary project; the model's replies are faked at
 * `streamChat`, and the Tauri vector-store and embedding commands are an
 * in-memory store with a deterministic embedding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createTempProject, readFileRaw, realFs, writeFileRaw } from "@/test-helpers/fs-temp"
import { createFakeVectorStore } from "@/test-helpers/fake-vector-store"

const store = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeVectorStore> | null }))
const written = vi.hoisted(() => ({ paths: [] as string[] }))
const generation = vi.hoisted(() => ({ reply: "" }))

vi.mock("@/commands/fs", () => ({
  ...realFs,
  writeFile: async (path: string, contents: string) => {
    written.paths.push(path)
    await realFs.writeFile(path, contents)
  },
}))
vi.mock("./mineru", () => ({
  parseWithMineru: vi.fn(),
  parseWithMineruResult: vi.fn(),
}))
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => store.current!.invoke(cmd, args),
}))
vi.mock("./llm-client", () => ({
  streamChat: vi.fn(async (_cfg, messages, cb) => {
    const system = String(messages?.[0]?.content ?? "")
    if (system.startsWith("You are an expert research analyst")) {
      cb.onToken("## Key Concepts\n- Release planning.\n\n## Topics\nRelease Planning\n")
    } else if (system.startsWith("You are a wiki maintainer")) {
      cb.onToken(generation.reply)
      cb.onDone({ finishReason: "stop", truncated: false })
      return
    }
    cb.onDone()
  }),
}))

import { resetEmbeddingOptimizeAccountingForTests } from "./embedding"
import { sha256 } from "./ingest-cache"
import { autoIngest } from "./ingest"
import { useActivityStore } from "@/stores/activity-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore, type LlmConfig } from "@/stores/wiki-store"

const SOURCE = "release-notes.md"

/** Front matter shaped like the live Agent Harness Wiki vault's pages. */
function page(type: string, title: string, body: string): string {
  return [
    "---",
    `type: ${type}`,
    `title: ${title}`,
    "created: 2026-10-06",
    "updated: 2026-10-06",
    "tags: []",
    "related: []",
    `sources: ["${SOURCE}"]`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n")
}

const PAGES: Record<string, string> = {
  "wiki/sources/release-notes.md": page("source", "Release Notes", "Notes on the release plan."),
  "wiki/concepts/release-calendar.md": page("concept", "Release Calendar", "A calendar of planned releases."),
  "wiki/entities/release-train.md": page("entity", "Release Train", "The release train leaves every fortnight."),
}

let tmp: { path: string; cleanup: () => Promise<void> }

beforeEach(async () => {
  store.current = createFakeVectorStore()
  written.paths = []
  resetEmbeddingOptimizeAccountingForTests()
  generation.reply = Object.entries(PAGES)
    .map(([path, content]) => `---FILE: ${path}---\n${content}---END FILE---`)
    .join("\n")

  tmp = await createTempProject("ingest-embed-record")
  await writeFileRaw(`${tmp.path}/purpose.md`, "# Purpose\n\nRelease tooling research.\n")
  await writeFileRaw(`${tmp.path}/wiki/index.md`, "# Index\n")
  await writeFileRaw(`${tmp.path}/wiki/overview.md`, "# Overview\n")
  await writeFileRaw(`${tmp.path}/wiki/log.md`, "# Wiki Log\n")
  await writeFileRaw(`${tmp.path}/raw/sources/${SOURCE}`, "# Release notes\n\nHow releases are planned.\n")

  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useWikiStore.setState({
    project: { id: "ingest-embed-record", name: "ingest-embed-record", path: tmp.path },
    fileTree: [],
    outputLanguage: "auto",
    activePresetId: "openai",
    projectLlmOverride: { enabled: false, presetId: null, model: "" },
    taskModelRouting: { chatPresetId: null, ingestPresetId: null },
    multimodalConfig: { ...useWikiStore.getState().multimodalConfig, enabled: false },
    embeddingConfig: { enabled: true, endpoint: "http://127.0.0.1:1234/v1/embeddings", apiKey: "", model: "test-embedder" },
    mineruConfig: { enabled: false, backend: "cloud", token: "", modelVersion: "vlm" },
  })
})

afterEach(async () => {
  useWikiStore.setState({ embeddingConfig: { enabled: false, endpoint: "", apiKey: "", model: "" } })
  await tmp.cleanup()
})

describe("ingest – the embedded-pages record (#73)", () => {
  it("is written once, with every page the ingest embedded", async () => {
    const llmConfig: LlmConfig = { ...useWikiStore.getState().llmConfig, model: "fake-model", maxContextSize: 204_800 }

    await autoIngest(tmp.path, `${tmp.path}/raw/sources/${SOURCE}`, llmConfig)

    expect([...store.current!.pages.keys()].sort()).toEqual([
      "concepts/release-calendar",
      "entities/release-train",
      "sources/release-notes",
    ])
    expect(written.paths.filter((p) => p.endsWith("/.llm-wiki/embedded-pages.json"))).toHaveLength(1)
    const record = JSON.parse(await readFileRaw(`${tmp.path}/.llm-wiki/embedded-pages.json`))
    for (const [path, content] of Object.entries(PAGES)) {
      const id = path.replace(/^wiki\//, "").replace(/\.md$/, "")
      expect(record[id]).toBe(await sha256(await readFileRaw(`${tmp.path}/${path}`)))
      expect(await readFileRaw(`${tmp.path}/${path}`)).toContain(content.split("\n")[2])
    }
  })
})
