import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import "@/i18n"
import { DuplicateGroupCard } from "./maintenance-section"

const REFUSAL = 'Slug "agent-skills" names 2 pages: concepts/agent-skills, entities/agent-skills'

function render(refusal: string | null, skipped = false): string {
  const noop = () => {}
  return renderToStaticMarkup(createElement(DuplicateGroupCard, {
    entry: {
      group: { slugs: ["agent-skills", "skills"], confidence: "high", reason: "same topic" },
      canonicalSlug: "agent-skills",
      skipped,
      refusal,
    },
    task: undefined,
    merged: false,
    pendingPosition: 0,
    onCanonicalChange: noop,
    onEnqueue: noop,
    onCancel: noop,
    onRetry: noop,
    onNotDuplicate: noop,
  }))
}

describe("DuplicateGroupCard", () => {
  it("says which pages a refused merge's slug names (#126)", () => {
    expect(render(REFUSAL)).toContain(REFUSAL.replace(/"/g, "&quot;"))
  })

  it("shows no refusal once the group is marked not duplicates", () => {
    expect(render(REFUSAL, true)).not.toContain("names 2 pages")
  })
})
