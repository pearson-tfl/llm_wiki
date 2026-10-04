import { describe, expect, it } from "vitest"
import { assertCopyVault } from "./copy-vault"

describe("assertCopyVault", () => {
  it.each(["baseline", "vault", "control"])("takes a prove-on-copy.sh %s copy", (side) => {
    expect(() => assertCopyVault(`/tmp/llmw-3-ext-rename/run-20261004T230854/${side}`)).not.toThrow()
  })

  it.each([
    "/Users/johnp/Code/Agent-Harness-Reconfig/Agent-Harness-Wiki-Experiment",
    "/tmp/llmw-3-ext-rename/run-20261004T230854/vault/",
    "/tmp/llmw-3-ext-rename/run-latest/vault",
    "/tmp/llmw-3-ext-rename/run-20261004T230854/stores-after-apply",
  ])("refuses %s", (path) => {
    expect(() => assertCopyVault(path)).toThrow("not a prove-on-copy.sh copy")
  })
})
