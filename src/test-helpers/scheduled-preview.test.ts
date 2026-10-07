import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { tempVaultCopy } from "./scheduled-preview"
import { appFs } from "./fs-temp"
import type { FileNode } from "@/types/wiki"

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmw111-guard-"))
  made.push(dir)
  return dir
}

describe("tempVaultCopy", () => {
  it("accepts a folder under the OS temp folder, as its real path", async () => {
    const dir = await tempDir()
    expect(await tempVaultCopy(dir)).toBe(await fs.realpath(dir))
  })

  it("refuses a folder outside the OS temp folder", async () => {
    await expect(tempVaultCopy(__dirname)).rejects.toThrow("not a copy under the OS temp folder")
  })

  it("refuses a link under the temp folder that points outside it", async () => {
    const link = path.join(await tempDir(), "vault")
    await fs.symlink(__dirname, link)
    await expect(tempVaultCopy(link)).rejects.toThrow("not a copy under the OS temp folder")
  })

  it("refuses a path that cannot be read", async () => {
    await expect(tempVaultCopy(path.join(await tempDir(), "missing"))).rejects.toThrow()
  })
})

describe("appFs.listDirectory", () => {
  it("hides dot-prefixed entries, as the app does, unless asked for them", async () => {
    const dir = await tempDir()
    await fs.mkdir(path.join(dir, ".llm-wiki/page-history"), { recursive: true })
    await fs.mkdir(path.join(dir, "wiki"), { recursive: true })
    await fs.writeFile(path.join(dir, ".llm-wiki/page-history/old.md"), "x")
    await fs.writeFile(path.join(dir, "wiki/page.md"), "x")
    const names = (nodes: FileNode[]): string[] =>
      nodes.flatMap((n) => [n.name, ...names(n.children ?? [])])

    expect(names(await appFs.listDirectory(dir))).toEqual(["wiki", "page.md"])
    expect(names(await appFs.listDirectory(dir, { includeHidden: true }))).toContain("old.md")
  })
})
