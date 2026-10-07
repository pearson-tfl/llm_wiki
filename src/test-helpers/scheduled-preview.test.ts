import { afterEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { tempVaultCopy } from "./scheduled-preview"

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
