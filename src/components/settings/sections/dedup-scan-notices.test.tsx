import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import i18n from "@/i18n"
import en from "@/i18n/en.json"
import itBundle from "@/i18n/it.json"
import ru from "@/i18n/ru.json"
import zh from "@/i18n/zh.json"
import { DuplicateScanNotices } from "./dedup-scan-notices"

const CLEAN = "No duplicate groups found. The wiki is clean."

function render(props: Parameters<typeof DuplicateScanNotices>[0]): string {
  return renderToStaticMarkup(createElement(DuplicateScanNotices, props))
}

describe("DuplicateScanNotices", () => {
  it("says the wiki is clean when the model checked it and found nothing", () => {
    expect(render({ groupCount: 0, failedBatches: [] })).toContain(CLEAN)
  })

  it.each([
    ["embedding-coverage-low", "too few of its 251 pages could be embedded"],
    ["no-candidate-pairs", "found no candidate pairs among its 251 pages"],
  ] as const)("says a scan the model did not do, %s, was not done, never clean (#112)", (reason, text) => {
    const html = render({ groupCount: 0, failedBatches: [], notDone: { reason, pages: 251 } })

    expect(html).toContain("The duplicate scan was not done")
    expect(html).toContain(text)
    expect(html).not.toContain(CLEAN)
  })

  it("keeps the not-done notice beside groups found without the model (#112)", () => {
    const html = render({
      groupCount: 1,
      failedBatches: [],
      notDone: { reason: "no-candidate-pairs", pages: 251 },
    })

    expect(html).toContain("The duplicate scan was not done")
  })

  it("names failed detector batches and says nothing is clean (#108)", () => {
    const html = render({ groupCount: 0, failedBatches: [{ pages: 80, reason: "invalid JSON" }] })

    expect(html).toContain("1 detector batches (80 pages) could not be read")
    expect(html).not.toContain(CLEAN)
  })

  it.each([
    ["en", en],
    ["it", itBundle],
    ["ru", ru],
    ["zh", zh],
  ] as const)("shows each not-done reason in %s from its own bundle (#112)", async (lng, bundle) => {
    await i18n.changeLanguage(lng)
    try {
      const dedup = bundle.settings.sections.maintenance.dedup
      for (const [reason, text] of [
        ["embedding-coverage-low", dedup.notDoneCoverageLow],
        ["no-candidate-pairs", dedup.notDoneNoPairs],
      ] as const) {
        const html = render({ groupCount: 0, failedBatches: [], notDone: { reason, pages: 251 } })
        expect(html).toContain(text.replace("{{pages}}", "251"))
      }
    } finally {
      await i18n.changeLanguage("en")
    }
  })
})
