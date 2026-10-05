import { beforeEach, describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"

const tauriMocks = vi.hoisted(() => {
  const listeners: Record<string, (event: { payload: unknown }) => void> = {}
  return {
    invoke: vi.fn(async (_command: string, _payload?: unknown): Promise<unknown> => undefined),
    listen: vi.fn(async (event: string, cb: (event: { payload: unknown }) => void) => {
      listeners[event] = cb
      return vi.fn(() => {
        delete listeners[event]
      })
    }),
    emit: (event: string, payload: unknown) => listeners[event]?.({ payload }),
    reset: () => {
      for (const event of Object.keys(listeners)) {
        delete listeners[event]
      }
    },
  }
})

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}))

import {
  createClaudeCodeStreamParser,
  buildExitError,
  createBoundedDiagnosticBuffer,
  extractClaudeCodeStructuredError,
  shouldCaptureClaudeDiagnostic,
  streamClaudeCodeCli,
} from "../claude-cli-transport"
import { buildDedupLlmCall } from "../dedup-runner"
import { MergeReplyRejectedError } from "../dedup"
import { useWikiStore } from "@/stores/wiki-store"

beforeEach(() => {
  vi.clearAllMocks()
  tauriMocks.reset()
  tauriMocks.invoke.mockResolvedValue(undefined)
  useWikiStore.setState({
    project: {
      id: "project-1",
      name: "Project",
      path: "/Users/me/wiki-project",
    },
  })
})

describe("createClaudeCodeStreamParser", () => {
  it("emits text from a single stream_event text_delta", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    })
    expect(parse(line)).toBe("Hello")
  })

  it("accumulates multiple stream_event deltas in order", () => {
    const parse = createClaudeCodeStreamParser()
    const mk = (t: string) =>
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
      })
    expect(parse(mk("Hello "))).toBe("Hello ")
    expect(parse(mk("world"))).toBe("world")
    expect(parse(mk("!"))).toBe("!")
  })

  it("falls back to `assistant` message text when no deltas arrived", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi there" }] },
    })
    expect(parse(line)).toBe("Hi there")
  })

  it("emits only the novel tail when `assistant` events ship cumulative text", () => {
    // Older claude CLI versions re-send the full in-progress message on
    // each assistant event instead of emitting deltas. The parser must
    // diff those so the UI doesn't render "HiHi thereHi there, friend".
    const parse = createClaudeCodeStreamParser()
    const mk = (t: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } })
    expect(parse(mk("Hi"))).toBe("Hi")
    expect(parse(mk("Hi there"))).toBe(" there")
    expect(parse(mk("Hi there, friend"))).toBe(", friend")
  })

  it("skips `assistant` events entirely once stream_event deltas are seen", () => {
    // When both event types are present (newer CLIs with --verbose),
    // deltas are authoritative and the fat `assistant` events would
    // duplicate text if we emitted them.
    const parse = createClaudeCodeStreamParser()
    const delta = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    })
    const asst = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    })
    expect(parse(delta)).toBe("Hi")
    expect(parse(asst)).toBeNull()
  })

  it("concatenates multiple text parts inside one `assistant` event", () => {
    const parse = createClaudeCodeStreamParser()
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part one. " },
          { type: "tool_use", id: "x", name: "bash", input: {} },
          { type: "text", text: "Part two." },
        ],
      },
    })
    expect(parse(line)).toBe("Part one. Part two.")
  })

  it("returns null for system init, result, tool_use, and unknown types", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "result", subtype: "success", result: "done" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "tool_use", id: "x" }))).toBeNull()
    expect(parse(JSON.stringify({ type: "future_type_we_dont_know" }))).toBeNull()
  })

  it("returns null for malformed JSON or blank lines", () => {
    const parse = createClaudeCodeStreamParser()
    expect(parse("")).toBeNull()
    expect(parse("   ")).toBeNull()
    expect(parse("not json at all")).toBeNull()
    expect(parse("{bad json")).toBeNull()
  })

  it("returns null for stream_event shapes we don't recognize (usage/etc.)", () => {
    const parse = createClaudeCodeStreamParser()
    // e.g. message_start / message_delta / ping — Anthropic lifecycle
    // events that carry no user-visible text.
    expect(
      parse(
        JSON.stringify({
          type: "stream_event",
          event: { type: "message_start", message: { id: "m" } },
        }),
      ),
    ).toBeNull()
    expect(
      parse(
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "{\"a\":" },
          },
        }),
      ),
    ).toBeNull()
  })
})

describe("streamClaudeCodeCli", () => {
  it("does not resolve until the Claude CLI done event arrives", async () => {
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }
    let settled = false
    let resolveSpawn: (() => void) | undefined
    tauriMocks.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveSpawn = resolve
    }))

    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    ).finally(() => {
      settled = true
    })

    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    })
    expect(tauriMocks.invoke).toHaveBeenCalledWith(
      "claude_cli_spawn",
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Analyze this source." }],
        workingDirectory: "/Users/me/wiki-project",
      }),
    )

    expect(resolveSpawn).toBeTypeOf("function")
    let spawnSettled = false
    void Promise.resolve(tauriMocks.invoke.mock.results[0]?.value).then(() => {
      spawnSettled = true
    })
    resolveSpawn?.()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spawnSettled).toBe(true)
    expect(settled).toBe(false)

    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "structured analysis" },
        },
      }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 0, stderr: "" })

    await stream

    expect(callbacks.onToken).toHaveBeenCalledWith("structured analysis")
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("passes local CLI isolation preference to the Rust transport", async () => {
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
        localCliIsolation: true,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )

    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "claude_cli_spawn",
        expect.objectContaining({ isolateLocalConfig: true }),
      )
    })

    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 0, stderr: "" })

    await stream
  })

  it("passes the active project path as the Claude CLI working directory", async () => {
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )

    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledWith(
        "claude_cli_spawn",
        expect.objectContaining({ workingDirectory: "/Users/me/wiki-project" }),
      )
    })

    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
    tauriMocks.emit(
      `claude-cli:${payload.streamId}`,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
    )
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 0, stderr: "" })

    await stream
  })

  it("surfaces an error without spawning when no project is active", async () => {
    useWikiStore.setState({ project: null })
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    await streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )

    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("claude_cli_spawn", expect.anything())
    expect(tauriMocks.listen).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/working directory/),
    })
  })

  it("surfaces a clear error when completion has no assistant text", async () => {
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    const stream = streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
    )

    await vi.waitFor(() => {
      expect(tauriMocks.invoke).toHaveBeenCalledTimes(1)
    })

    const payload = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
    tauriMocks.emit(`claude-cli:${payload.streamId}:done`, { code: 0, stderr: "" })

    await stream

    expect(callbacks.onToken).not.toHaveBeenCalled()
    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: expect.stringContaining("completed but returned no content"),
      }),
    )
  })

  it("does not spawn when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const callbacks = {
      onToken: vi.fn(),
      onDone: vi.fn(),
      onError: vi.fn(),
    }

    await streamClaudeCodeCli(
      {
        provider: "claude-code",
        apiKey: "",
        model: "claude-sonnet-4-6",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 200000,
      },
      [{ role: "user", content: "Analyze this source." }],
      callbacks,
      controller.signal,
    )

    expect(tauriMocks.invoke).not.toHaveBeenCalled()
    expect(tauriMocks.listen).not.toHaveBeenCalled()
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).not.toHaveBeenCalled()
  })
})

// Stdout recorded from claude 2.1.289 run with the app's flags on
// claude-opus-5-5 (#32). The two limit-hit runs went through a relay that
// cut the request's output cap to 40 tokens: the first request only
// (resumed), or every request (exhausted).
const CLI_CONFIG = {
  provider: "claude-code" as const,
  apiKey: "",
  model: "claude-opus-5-5",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 1000000,
}

/** Feed a recorded stdout to the CLI the caller just spawned, then its exit. */
async function emitRecordedStdout(
  fixture: string,
  exitCode: number,
  edit: (line: string) => string = (line) => line,
) {
  await vi.waitFor(() => {
    expect(tauriMocks.invoke).toHaveBeenCalledWith("claude_cli_spawn", expect.anything())
  })
  const { streamId } = tauriMocks.invoke.mock.calls[0]?.[1] as { streamId: string }
  const stdout = readFileSync(new URL(`./fixtures/claude-cli/${fixture}`, import.meta.url), "utf8")
  for (const line of stdout.split("\n").filter(Boolean)) {
    tauriMocks.emit(`claude-cli:${streamId}`, edit(line))
  }
  tauriMocks.emit(`claude-cli:${streamId}:done`, { code: exitCode, stderr: "" })
}

async function replayClaudeCliStdout(
  fixture: string,
  exitCode: number,
  edit?: (line: string) => string,
) {
  const callbacks = { onToken: vi.fn(), onDone: vi.fn(), onError: vi.fn() }
  const stream = streamClaudeCodeCli(
    CLI_CONFIG,
    [{ role: "user", content: "Write a paragraph about rivers." }],
    callbacks,
  )
  await emitRecordedStdout(fixture, exitCode, edit)
  await stream
  return callbacks
}

describe("streamClaudeCodeCli output limit (#32)", () => {
  it("reports the result event's stop reason on a normal reply, not cut off", async () => {
    const callbacks = await replayClaudeCliStdout("normal-reply.jsonl", 0)

    expect(callbacks.onToken.mock.calls.map(([token]) => token).join("")).toBe("the river runs.")
    expect(callbacks.onDone).toHaveBeenCalledWith({ finishReason: "end_turn", truncated: false })
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("flags a reply cut off when the CLI hit its output limit and resumed", async () => {
    const callbacks = await replayClaudeCliStdout("limit-hit-resumed.jsonl", 0)

    expect(callbacks.onDone).toHaveBeenCalledWith({ finishReason: "end_turn", truncated: true })
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it("flags a reply cut off when the result event stops at max_tokens", async () => {
    // The normal reply with the result's stop reason set to the Anthropic
    // API's own term for an output-limit stop.
    const callbacks = await replayClaudeCliStdout("normal-reply.jsonl", 0, (line) =>
      line.replace('"stop_reason":"end_turn"', '"stop_reason":"max_tokens"'))

    expect(callbacks.onDone).toHaveBeenCalledWith({ finishReason: "max_tokens", truncated: true })
  })

  it("has a duplicate merge reject the resumed reply, through the client (#32)", async () => {
    const merge = buildDedupLlmCall(CLI_CONFIG, 16384, { completeReplyOnly: true })("system", "user")
    await emitRecordedStdout("limit-hit-resumed.jsonl", 0)

    const rejection = await merge.catch((err: unknown) => err)
    expect(rejection).toBeInstanceOf(MergeReplyRejectedError)
    expect((rejection as Error).message).toBe("Merge reply rejected: the model's reply was cut off at its output limit")
  })

  it("fails a reply whose resumes ran out, as the CLI exits 1", async () => {
    const callbacks = await replayClaudeCliStdout("limit-hit-exhausted.jsonl", 1)

    expect(callbacks.onDone).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/exceeded the 128000 output token maximum/) }),
    )
  })
})

describe("buildExitError", () => {
  it("translates Unauthenticated stderr into an actionable login hint", () => {
    const msg = buildExitError(1, "Unauthenticated: please log in")
    expect(msg).toMatch(/not authenticated/i)
    // Estate fork: LLM Wiki runs claude on ~/.claude (claude_cli.rs), so the
    // hint must sign in that same config dir. See ESTATE.md.
    expect(msg).toContain("`CLAUDE_CONFIG_DIR=~/.claude claude`")
    expect(msg).toMatch(/terminal/i)
  })

  it("includes the original stderr at the bottom for context", () => {
    const stderr = "Unauthenticated: token expired"
    const msg = buildExitError(1, stderr)
    expect(msg).toContain(stderr)
  })

  it("falls through to the bare exit-code form for unrecognized stderr", () => {
    expect(buildExitError(2, "Unknown flag: --foo")).toBe(
      "claude CLI exited with code 2: Unknown flag: --foo",
    )
  })

  it("works without stderr at all (truly silent exit)", () => {
    const msg = buildExitError(127, "")
    expect(msg).toMatch(/silently/)
    expect(msg).toMatch(/127/)
    expect(msg).toMatch(/terminal/)
  })

  it("matches the case-insensitive Authentication failed variant", () => {
    const msg = buildExitError(1, "Authentication failed (401)")
    expect(msg).toMatch(/not authenticated/i)
  })

  it("recognizes OAuth authentication failures emitted on stdout", () => {
    const msg = buildExitError(1, "", "Failed to authenticate: OAuth session expired")
    expect(msg).toMatch(/not authenticated/i)
    expect(msg).toContain("OAuth session expired")
  })

  it("falls back to unparsed stdout when stderr is empty (the real-user case)", () => {
    // Real-user scenario: claude exit 1, stderr empty, but stdout
    // had a structured error event our parser didn't recognize.
    // Without this branch the user just saw "exited with code 1"
    // and had to grep the binary to guess what went wrong.
    const stdout = '{"type":"error","subtype":"oauth_expired","message":"token revoked"}'
    const msg = buildExitError(1, "", stdout)
    expect(msg).toMatch(/not authenticated/i)
    // Estate fork: the hint signs in ~/.claude, as in the test above.
    expect(msg).toContain("`CLAUDE_CONFIG_DIR=~/.claude claude`")
    expect(msg).toContain("oauth_expired")
    expect(msg).toContain("token revoked")
  })

  it("prefers stderr over unparsed stdout when both are present", () => {
    const msg = buildExitError(1, "real stderr here", "unrelated stdout")
    expect(msg).toContain("real stderr here")
    expect(msg).not.toContain("unrelated stdout")
  })

  it("recommends terminal reproduction when both stderr and stdout are empty", () => {
    const msg = buildExitError(1, "", "")
    expect(msg).toMatch(/silently/)
    expect(msg).toMatch(/terminal/)
    expect(msg).toMatch(/Anthropic API/)
  })
})

describe("extractClaudeCodeStructuredError", () => {
  it("extracts failed result events from Claude Code", () => {
    expect(extractClaudeCodeStructuredError(JSON.stringify({
      type: "result",
      is_error: true,
      result: "Failed to authenticate: OAuth session expired",
    }))).toBe("Failed to authenticate: OAuth session expired")
  })

  it("ignores successful result events", () => {
    expect(extractClaudeCodeStructuredError(JSON.stringify({
      type: "result",
      is_error: false,
      result: "done",
    }))).toBeNull()
  })

  it("extracts nested error messages", () => {
    expect(extractClaudeCodeStructuredError(JSON.stringify({
      type: "error",
      error: { message: "rate limit exceeded" },
    }))).toBe("rate limit exceeded")
  })
})

describe("Claude CLI diagnostic buffering", () => {
  it("ignores normal structured lifecycle and hook events", () => {
    expect(shouldCaptureClaudeDiagnostic(JSON.stringify({
      type: "system",
      subtype: "hook_started",
      message: "running hook",
    }))).toBe(false)
    expect(shouldCaptureClaudeDiagnostic(JSON.stringify({
      type: "result",
      is_error: false,
      result: "done",
    }))).toBe(false)
  })

  it("keeps non-JSON and structured error diagnostics", () => {
    expect(shouldCaptureClaudeDiagnostic("fatal process failure")).toBe(true)
    expect(shouldCaptureClaudeDiagnostic(JSON.stringify({
      type: "result",
      is_error: true,
      result: "token expired",
    }))).toBe(true)
  })

  it("retains the newest diagnostics when capacity is exceeded", () => {
    const buffer = createBoundedDiagnosticBuffer(12)
    buffer.append("old-message")
    buffer.append("FINAL-ERROR")
    expect(buffer.value()).toContain("FINAL-ERROR")
    expect(buffer.value()).not.toContain("old-message")
    expect(Array.from(buffer.value()).length).toBeLessThanOrEqual(12)
  })

  it("does not split unicode code points at the capacity boundary", () => {
    const buffer = createBoundedDiagnosticBuffer(3)
    buffer.append("错误信息")
    expect(buffer.value()).toBe("误信息")
  })
})
