import { describe, it, expect } from "vitest"
import { isRelativePathHref, resolveRelativeLink } from "./relative-links"
import { buildProjectPathIndexFromTree } from "./wiki-page-resolver"
import type { FileNode } from "@/types/wiki"

// Link targets copied from a real wiki vault (the Agent Harness Wiki), as
// react-markdown hands them to an <a href>, except where marked.
describe("isRelativePathHref", () => {
  it.each([
    ["../../../resources/engineering-loop-measurement.md"],
    ["./01-setup.md"],
    ["SKILL.md"],
    ["./06-verify-and-ship.md#create-a-project-verification-skill"],
    ["/docs/en/mcp#dynamic-tool-updates"],
    ["sections/00-harness-thesis/"],
    ["../assets/learn-agent-arch-ext-ai-agent-book-readme/translations-15%20languages-informational.svg"],
  ])("treats %s as a path link", (href) => {
    expect(isRelativePathHref(href)).toBe(true)
  })

  it.each([
    ["#a-stateless-protocol"],
    ["https://12factor.net/"],
    ["mailto:bigbench@googlegroups.com"],
    // Made up: protocol-relative, which is a web link.
    ["//example.com/x"],
    [""],
    [null],
  ])("does not treat %s as a path link", (href) => {
    expect(isRelativePathHref(href)).toBe(false)
  })
})

const VAULT = "/Users/someone/Agent-Harness-Wiki-Experiment"

function file(path: string): FileNode {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, is_dir: false }
}

const index = buildProjectPathIndexFromTree([
  file(`${VAULT}/raw/sources/learn-agent-arch-ext-ai-agent-book-readme.md`),
  file(`${VAULT}/raw/assets/learn-agent-arch-ext-ai-agent-book-readme/translations-15 languages-informational.svg`),
  // Made up: the vault has no 01-setup.md beside the page that links it.
  file(`${VAULT}/raw/sources/01-setup.md`),
  // Made up: the vault has no such folder; it stands for the one its link names.
  {
    name: "sections",
    path: `${VAULT}/wiki/sources/sections`,
    is_dir: true,
    children: [{ name: "00-harness-thesis", path: `${VAULT}/wiki/sources/sections/00-harness-thesis`, is_dir: true, children: [] }],
  },
])

describe("resolveRelativeLink", () => {
  it("resolves a link against the folder of the page it is written in, decoding %20", () => {
    expect(
      resolveRelativeLink(
        "../assets/learn-agent-arch-ext-ai-agent-book-readme/translations-15%20languages-informational.svg",
        `${VAULT}/raw/sources`,
        index,
      ),
    ).toBe(`${VAULT}/raw/assets/learn-agent-arch-ext-ai-agent-book-readme/translations-15 languages-informational.svg`)
  })

  it("resolves a ./ link and drops its #section", () => {
    expect(resolveRelativeLink("./01-setup.md", `${VAULT}/raw/sources`, index)).toBe(`${VAULT}/raw/sources/01-setup.md`)
    // Made up: the vault's ./06-verify-and-ship.md#… form, pointed at a file the index has.
    expect(resolveRelativeLink("./01-setup.md#install", `${VAULT}/raw/sources`, index)).toBe(`${VAULT}/raw/sources/01-setup.md`)
  })

  it.each([
    // Made up: project folders whose names a URL would misread.
    ["/Users/someone/vault #1"],
    ["/Users/someone/100%"],
    ["/Users/someone/a?b"],
    ["/Users/someone/v%20x"],
  ])("resolves under a project folder named %s", (root) => {
    const odd = buildProjectPathIndexFromTree([file(`${root}/raw/sources/01-setup.md`)])
    expect(resolveRelativeLink("./01-setup.md", `${root}/raw/sources`, odd)).toBe(`${root}/raw/sources/01-setup.md`)
  })

  it.each([
    // Climbs out of the project: no such file in it.
    ["../../../resources/engineering-loop-measurement.md", `${VAULT}/raw/sources`],
    ["SKILL.md", `${VAULT}/raw/sources`],
    ["/docs/en/mcp#dynamic-tool-updates", `${VAULT}/wiki/sources`],
    // A folder is not a page.
    ["sections/00-harness-thesis/", `${VAULT}/wiki/sources`],
    // Made up: a malformed percent sequence.
    ["%E0%A4%A.md", `${VAULT}/raw/sources`],
  ])("finds no file for %s", (href, fromDir) => {
    expect(resolveRelativeLink(href, fromDir, index)).toBeNull()
  })
})
