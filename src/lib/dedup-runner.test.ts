/**
 * Unit coverage for `buildDedupLlmCall`. Mocks streamChat so we can
 * pin the request overrides it forwards — specifically that dedup
 * (like every other structured-output caller) disables thinking. A
 * reasoning-capable model left thinking-on burns its whole budget on
 * chain-of-thought and ends the stream with empty content, which on
 * the scan path runs silently to the 30-min backstop and surfaces as
 * a bare "Request cancelled".
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

// vi.mock is hoisted above imports; vi.hoisted keeps the fn out of the TDZ.
const {
  mockCandidatePairs,
  mockClusterByPairs,
  mockListDirectory,
  mockLoadEmbeddingConfig,
  mockLoadNotDuplicates,
  mockReadFile,
  mockStreamChat,
} = vi.hoisted(() => ({
  mockCandidatePairs: vi.fn(),
  mockClusterByPairs: vi.fn(),
  mockListDirectory: vi.fn(),
  mockLoadEmbeddingConfig: vi.fn(),
  mockLoadNotDuplicates: vi.fn(),
  mockReadFile: vi.fn(),
  mockStreamChat: vi.fn(),
}))
vi.mock("./llm-client", async () => {
  const actual = await vi.importActual<typeof import("./llm-client")>("./llm-client")
  return { ...actual, streamChat: mockStreamChat }
})
vi.mock("@/commands/fs", () => ({
  listDirectory: mockListDirectory,
  readFile: mockReadFile,
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}))
vi.mock("@/lib/project-store", () => ({
  loadEmbeddingConfig: mockLoadEmbeddingConfig,
}))
vi.mock("./dedup-storage", () => ({
  loadNotDuplicates: mockLoadNotDuplicates,
}))
vi.mock("@/lib/dedup_embedding", () => ({
  candidatePairs: mockCandidatePairs,
  clusterByPairs: mockClusterByPairs,
  DuplicatePrefilterCancelledError: class DuplicatePrefilterCancelledError extends Error {
    name = "AbortError"
  },
}))

import { buildDedupLlmCall, runDuplicateDetection } from "./dedup-runner"
import { DetectorReplyUnreadableError } from "./dedup"
import type { LlmConfig } from "@/stores/wiki-store"

const cfg: LlmConfig = {
  provider: "ollama",
  apiKey: "",
  model: "qwen3:8b",
  ollamaUrl: "http://localhost:11434",
  customEndpoint: "",
  apiMode: "chat_completions",
  maxContextSize: 8192,
}

const FOO_PATH = "/project/wiki/entities/foo.md"
const BAR_PATH = "/project/wiki/entities/bar.md"
const BAZ_PATH = "/project/wiki/entities/baz.md"
const FOO_REL = "wiki/entities/foo.md"
const BAR_REL = "wiki/entities/bar.md"

beforeEach(() => {
  mockCandidatePairs.mockReset()
  mockClusterByPairs.mockReset()
  mockListDirectory.mockReset()
  mockLoadEmbeddingConfig.mockReset()
  mockLoadNotDuplicates.mockReset()
  mockReadFile.mockReset()
  mockStreamChat.mockReset()
})

function setupThreePageProject() {
  mockListDirectory.mockResolvedValue([
    {
      name: "wiki",
      path: "/project/wiki",
      is_dir: true,
      children: [
        {
          name: "entities",
          path: "/project/wiki/entities",
          is_dir: true,
          children: [
            { name: "foo.md", path: FOO_PATH, is_dir: false },
            { name: "bar.md", path: BAR_PATH, is_dir: false },
            { name: "baz.md", path: BAZ_PATH, is_dir: false },
          ],
        },
      ],
    },
  ])
  mockReadFile.mockImplementation(async (path: string) => {
    const slug = path.split("/").pop()?.replace(/\.md$/, "") ?? "unknown"
    return `---\ntype: entity\ntitle: ${slug}\ntags: []\n---\n${slug} body`
  })
}

function setupEmbeddingConfig(enabled = true) {
  mockLoadEmbeddingConfig.mockResolvedValue({
    enabled,
    endpoint: "http://localhost:1234/v1/embeddings",
    apiKey: "",
    model: "mock",
  })
}

function setupLargeProject(count = 251) {
  const children = Array.from({ length: count }, (_, i) => ({
    name: `p${i}.md`,
    path: `/project/wiki/entities/p${i}.md`,
    is_dir: false,
  }))
  mockListDirectory.mockResolvedValue([
    {
      name: "wiki",
      path: "/project/wiki",
      is_dir: true,
      children: [
        { name: "entities", path: "/project/wiki/entities", is_dir: true, children },
      ],
    },
  ])
  mockReadFile.mockImplementation(async (path: string) => {
    const slug = path.split("/").pop()?.replace(/\.md$/, "") ?? "unknown"
    return `---\ntype: entity\ntitle: ${slug}\ntags: []\n---\n${slug} body`
  })
}

function mockDetectorGroup(slugs: string[] = ["foo", "bar"]) {
  mockStreamChat.mockImplementation(async (_c, _m, cb) => {
    cb.onToken(JSON.stringify({
      groups: [{ slugs, reason: "same topic", confidence: "high" }],
    }))
    cb.onDone()
  })
}

describe("buildDedupLlmCall", () => {
  it("disables thinking and caps output so reasoning models answer instead of streaming chain-of-thought to the backstop", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken('{"groups": []}')
      cb.onDone()
    })

    const call = buildDedupLlmCall(cfg, 8192)
    const out = await call("system prompt", "user message", undefined)
    expect(out).toBe('{"groups": []}')

    const overrides = mockStreamChat.mock.calls[0][4]
    expect(overrides).toMatchObject({
      temperature: 0.1,
      reasoning: { mode: "off" },
      max_tokens: 8192,
    })
  })

  it("forwards the caller's max_tokens budget (detection small, merge generous)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    await buildDedupLlmCall(cfg, 32768)("s", "u", undefined)
    expect(mockStreamChat.mock.calls[0][4]).toMatchObject({ max_tokens: 32768 })
  })

  it("forces reasoning off even when the config requests a thinking mode", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())

    const reasoningCfg: LlmConfig = { ...cfg, reasoning: { mode: "high" } }
    await buildDedupLlmCall(reasoningCfg, 8192)("s", "u", undefined)

    expect(mockStreamChat.mock.calls[0][4]).toMatchObject({
      reasoning: { mode: "off" },
    })
  })

  it("forwards the abort signal through to streamChat", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => cb.onDone())
    const controller = new AbortController()

    await buildDedupLlmCall(cfg, 8192)("s", "u", controller.signal)

    expect(mockStreamChat.mock.calls[0][3]).toBe(controller.signal)
  })

  it("rethrows when streamChat reports an error (no silent empty result)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onError(new Error("HTTP 500: model unavailable"))
    })

    await expect(buildDedupLlmCall(cfg, 8192)("s", "u", undefined)).rejects.toThrow(
      /HTTP 500: model unavailable/,
    )
  })

  it("refuses a detection reply the client reports cut off at the cap (#108)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken('{"groups": []}')
      cb.onDone({ finishReason: "length", truncated: true })
    })

    await expect(buildDedupLlmCall(cfg, 8192)("s", "u", undefined)).rejects.toThrow(
      DetectorReplyUnreadableError,
    )
  })

  it("refuses a merge reply the client reports cut off at the cap (#29)", async () => {
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken("---\ntitle: foo\n---\nfoo body")
      cb.onDone({ finishReason: "length", truncated: true })
    })

    await expect(
      buildDedupLlmCall(cfg, 16384, { completeReplyOnly: true })("s", "u", undefined),
    ).rejects.toThrow(/Merge reply rejected: the model's reply was cut off at its output limit/)
  })

  it("refuses a merge reply whose signal fired, though the client ended it as done (#29)", async () => {
    const controller = new AbortController()
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken("---\ntitle: foo\n---\nfoo body")
      controller.abort()
      cb.onDone()
    })

    await expect(
      buildDedupLlmCall(cfg, 16384, { completeReplyOnly: true })("s", "u", controller.signal),
    ).rejects.toThrow("Duplicate merge cancelled before the model's reply finished")
  })
})

/** The slugs in each detector call, read from the prompt the model got. */
function detectorCallSlugs(): string[][] {
  return mockStreamChat.mock.calls.map((call) =>
    [...(call[1][1].content as string).matchAll(/slug=([^,]+),/g)].map((m) => m[1]),
  )
}

describe("runDuplicateDetection embedding prefilter", () => {
  it("sends only embedding candidate summaries to the LLM detector", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([[FOO_REL, BAR_REL]])
    mockClusterByPairs.mockReturnValue([[FOO_REL, BAR_REL]])
    mockDetectorGroup()

    const result = await runDuplicateDetection("/project", cfg)

    expect(result.groups).toEqual([
      { slugs: ["foo", "bar"], reason: "same topic", confidence: "high" },
    ])
    expect(mockCandidatePairs).toHaveBeenCalledOnce()
    const detectorUserMessage = mockStreamChat.mock.calls[0][1][1].content
    expect(detectorUserMessage).toContain("slug=foo")
    expect(detectorUserMessage).toContain("slug=bar")
    expect(detectorUserMessage).not.toContain("slug=baz")
  })

  it("splits a cluster bigger than the detector cap so every candidate pair shares a call (#108)", async () => {
    const count = 200
    setupLargeProject(count)
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    const rel = (i: number) => `wiki/entities/p${i % count}.md`
    // A near pair, a mid-range pair and a far pair per page: one cluster of 200.
    const pairs = Array.from({ length: count }, (_, i) => [
      [rel(i), rel(i + 1)],
      [rel(i), rel(i + 7)],
      [rel(i), rel(i + 61)],
    ]).flat()
    mockCandidatePairs.mockResolvedValue(pairs)
    mockClusterByPairs.mockReturnValue([Array.from({ length: count }, (_, i) => rel(i))])
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken('{"groups": []}')
      cb.onDone()
    })

    await runDuplicateDetection("/project", cfg)

    const calls = detectorCallSlugs()
    expect(calls.length).toBeGreaterThan(1)
    for (const slugs of calls) expect(slugs.length).toBeLessThanOrEqual(80)
    const slug = (path: string) => path.replace(/^wiki\/entities\/|\.md$/g, "")
    for (const [a, b] of pairs) {
      expect(calls.some((slugs) => slugs.includes(slug(a)) && slugs.includes(slug(b))), `${a} ${b}`)
        .toBe(true)
    }
  })

  it("reports a batch whose reply cannot be read as failed, keeping the other batches' groups (#108)", async () => {
    setupLargeProject(170)
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig(false)
    let call = 0
    mockStreamChat.mockImplementation(async (_c, messages, cb) => {
      call += 1
      const slugs = [...(messages[1].content as string).matchAll(/slug=([^,]+),/g)].map((m) => m[1])
      if (call === 2) {
        cb.onToken("I found several duplicates, listed below:")
      } else if (call === 3) {
        cb.onToken('{"groups": [{"slugs": ["p1", "p2"]')
        cb.onDone({ finishReason: "length", truncated: true })
        return
      } else {
        cb.onToken(JSON.stringify({
          groups: [{ slugs: slugs.slice(0, 2), reason: "same topic", confidence: "high" }],
        }))
      }
      cb.onDone()
    })

    const result = await runDuplicateDetection("/project", cfg)

    const calls = detectorCallSlugs()
    expect(calls).toHaveLength(3)
    expect(result.groups).toEqual([
      { slugs: calls[0].slice(0, 2), reason: "same topic", confidence: "high" },
    ])
    expect(result.failedBatches).toEqual([
      { pages: calls[1].length, reason: expect.stringMatching(/could not be read/) },
      { pages: calls[2].length, reason: expect.stringMatching(/cut off/) },
    ])
  })

  it("falls back to the full LLM scan when the embedding prefilter fails", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockRejectedValue(new Error("embedding endpoint unavailable"))
    mockDetectorGroup()

    await runDuplicateDetection("/project", cfg)

    const detectorUserMessage = mockStreamChat.mock.calls[0][1][1].content
    expect(detectorUserMessage).toContain("slug=foo")
    expect(detectorUserMessage).toContain("slug=bar")
    expect(detectorUserMessage).toContain("slug=baz")
  })

  it("falls back to the full LLM scan when persisted embedding config is malformed", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    mockLoadEmbeddingConfig.mockResolvedValue({
      enabled: true,
      apiKey: "",
      model: "mock",
    })
    mockDetectorGroup()

    await runDuplicateDetection("/project", cfg)

    expect(mockCandidatePairs).not.toHaveBeenCalled()
    const detectorUserMessage = mockStreamChat.mock.calls[0][1][1].content
    expect(detectorUserMessage).toContain("slug=baz")
  })

  it("falls back to the full LLM scan for small wikis when the prefilter returns no candidates", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([])
    mockDetectorGroup()

    const result = await runDuplicateDetection("/project", cfg)

    expect(result.groups).toEqual([
      { slugs: ["foo", "bar"], reason: "same topic", confidence: "high" },
    ])
    const detectorUserMessage = mockStreamChat.mock.calls[0][1][1].content
    expect(detectorUserMessage).toContain("slug=foo")
    expect(detectorUserMessage).toContain("slug=bar")
    expect(detectorUserMessage).toContain("slug=baz")
    expect(mockClusterByPairs).not.toHaveBeenCalled()
  })

  it("short-circuits large wiki scans when the prefilter returns no candidates", async () => {
    setupLargeProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([])

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual({ groups: [], failedBatches: [] })
    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(mockClusterByPairs).not.toHaveBeenCalled()
  })

  it("does not fall back to the full LLM scan for large wikis when embedding coverage is too low", async () => {
    setupLargeProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockRejectedValue(new Error("Duplicate prefilter embedded only 2/251 pages"))

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual({ groups: [], failedBatches: [] })
    expect(mockStreamChat).not.toHaveBeenCalled()
  })

  it("bounds every LLM request when a large wiki has no embedding prefilter", async () => {
    setupLargeProject(170)
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig(false)
    mockStreamChat.mockImplementation(async (_c, _m, cb) => {
      cb.onToken('{"groups": []}')
      cb.onDone()
    })

    await runDuplicateDetection("/project", cfg)

    expect(mockStreamChat.mock.calls.length).toBeGreaterThan(1)
    for (const call of mockStreamChat.mock.calls) {
      const prompt = call[1][1].content as string
      const count = Number(prompt.match(/Wiki pages to scan \((\d+) entries\)/)?.[1])
      expect(count).toBeGreaterThanOrEqual(2)
      expect(count).toBeLessThanOrEqual(80)
    }
  })

  it("keeps the not-duplicates whitelist active on the prefiltered path", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([["foo", "bar"]])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([[FOO_REL, BAR_REL]])
    mockClusterByPairs.mockReturnValue([[FOO_REL, BAR_REL]])

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual({ groups: [], failedBatches: [] })
    expect(mockStreamChat).not.toHaveBeenCalled()
  })

  it("propagates cancellation instead of falling back to a full scan", async () => {
    setupThreePageProject()
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    const controller = new AbortController()
    controller.abort()
    mockCandidatePairs.mockRejectedValue(new Error("Duplicate scan cancelled"))

    await expect(runDuplicateDetection("/project", cfg, { signal: controller.signal }))
      .rejects.toThrow(/cancelled/i)
    expect(mockStreamChat).not.toHaveBeenCalled()
  })
})

describe("runDuplicateDetection – pages sharing a slug (#109)", () => {
  const TWIN_GROUP = {
    slugs: ["concepts/agent-skills", "entities/agent-skills"],
    reason: 'Pages share the slug "agent-skills": concepts/agent-skills, entities/agent-skills',
    confidence: "medium",
  }

  /** The vault's pairs: one concept and one entity page per slug, beside `extra` other entity pages. */
  function setupTwinProject(extra: string[]) {
    const file = (folder: string, slug: string) =>
      ({ name: `${slug}.md`, path: `/project/wiki/${folder}/${slug}.md`, is_dir: false })
    mockListDirectory.mockResolvedValue([
      {
        name: "wiki",
        path: "/project/wiki",
        is_dir: true,
        children: [
          { name: "concepts", path: "/project/wiki/concepts", is_dir: true, children: [file("concepts", "agent-skills")] },
          {
            name: "entities",
            path: "/project/wiki/entities",
            is_dir: true,
            children: [file("entities", "agent-skills"), ...extra.map((slug) => file("entities", slug))],
          },
        ],
      },
    ])
    mockReadFile.mockImplementation(async (path: string) => {
      const type = path.includes("/concepts/") ? "concept" : "entity"
      const slug = path.split("/").pop()?.replace(/\.md$/, "") ?? "unknown"
      return `---\ntype: ${type}\ntitle: ${slug}\ntags: []\n---\n${slug} body`
    })
  }

  it("reports them as one group of their page ids when the model groups nothing", async () => {
    setupTwinProject(["foo"])
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig(false)
    mockDetectorGroup([])

    const result = await runDuplicateDetection("/project", cfg)

    expect(result).toEqual({ groups: [TWIN_GROUP], failedBatches: [] })
  })

  it("finds them from file names alone: a large wiki whose prefilter finds nothing calls no model", async () => {
    setupTwinProject(Array.from({ length: 250 }, (_, i) => `p${i}`))
    mockLoadNotDuplicates.mockResolvedValue([])
    setupEmbeddingConfig()
    mockCandidatePairs.mockResolvedValue([])

    const result = await runDuplicateDetection("/project", cfg)

    expect(mockStreamChat).not.toHaveBeenCalled()
    expect(result.groups).toEqual([TWIN_GROUP])
  })

  it("leaves out a pair the user marked not duplicates", async () => {
    setupTwinProject(["foo"])
    mockLoadNotDuplicates.mockResolvedValue([["concepts/agent-skills", "entities/agent-skills"]])
    setupEmbeddingConfig(false)
    mockDetectorGroup([])

    const result = await runDuplicateDetection("/project", cfg)

    expect(result.groups).toEqual([])
  })
})
