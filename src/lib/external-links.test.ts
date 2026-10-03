import { describe, it, expect, vi } from "vitest"
import { externalUrl, handleExternalLinkClick } from "./external-links"

// Link targets copied from a real wiki vault (the Agent Harness Wiki),
// as react-markdown hands them to an <a href>, except where marked.
describe("externalUrl", () => {
  it.each([
    ["https://12factor.net/", "https://12factor.net/"],
    ["http://agentskills.io", "http://agentskills.io/"],
    ["https://aclanthology.org/2024.tacl-1.9/", "https://aclanthology.org/2024.tacl-1.9/"],
    [
      "https://en.wikipedia.org/wiki/Crossover_%28evolutionary_algorithm%29",
      "https://en.wikipedia.org/wiki/Crossover_%28evolutionary_algorithm%29",
    ],
    ["mailto:bigbench@googlegroups.com", "mailto:bigbench@googlegroups.com"],
    // Made up: the vault sample with its scheme upper-cased.
    ["HTTPS://12factor.net/", "https://12factor.net/"],
  ])("sends %s to the system browser", (href, expected) => {
    expect(externalUrl(href)).toBe(expected)
  })

  it.each([
    ["#a-stateless-protocol"],
    // The vault's [[Offline regression evaluation|…]] after wikilink-transform.ts.
    ["#Offline%20regression%20evaluation"],
    ["../../../resources/engineering-loop-measurement.md"],
    // Made up: schemes the system browser should not be handed.
    ["file:///Users/someone/notes.md"],
    ["javascript:alert(1)"],
    [""],
    [null],
  ])("leaves %s to the app", (href) => {
    expect(externalUrl(href)).toBeNull()
  })
})

function clickOn(href: string | null, opts: { defaultPrevented?: boolean } = {}) {
  const anchor = { getAttribute: (name: string) => (name === "href" ? href : null) }
  const event = {
    defaultPrevented: opts.defaultPrevented ?? false,
    target: { closest: (selector: string) => (selector === "a[href]" && href !== null ? anchor : null) },
    preventDefault: vi.fn(),
  }
  return event
}

describe("handleExternalLinkClick", () => {
  it("opens an external link in the system browser and keeps the window where it is", () => {
    const open = vi.fn().mockResolvedValue(undefined)
    const event = clickOn("https://addyosmani.com/blog/agent-harness-engineering/")
    handleExternalLinkClick(event as unknown as MouseEvent, open)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith("https://addyosmani.com/blog/agent-harness-engineering/")
  })

  it("leaves a wiki link to the reader's own handler", () => {
    const open = vi.fn()
    const event = clickOn("#a-stateless-protocol")
    handleExternalLinkClick(event as unknown as MouseEvent, open)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it("does not open a link a component already handled", () => {
    const open = vi.fn()
    const event = clickOn("https://github.com/nashsu/llm_wiki", { defaultPrevented: true })
    handleExternalLinkClick(event as unknown as MouseEvent, open)
    expect(open).not.toHaveBeenCalled()
  })

  it("ignores a click outside any link", () => {
    const open = vi.fn()
    const event = clickOn(null)
    handleExternalLinkClick(event as unknown as MouseEvent, open)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it("keeps the window where it is when the opener fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const open = vi.fn().mockRejectedValue(new Error("not allowed"))
    const event = clickOn("mailto:bigbench@googlegroups.com")
    handleExternalLinkClick(event as unknown as MouseEvent, open)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })
})
