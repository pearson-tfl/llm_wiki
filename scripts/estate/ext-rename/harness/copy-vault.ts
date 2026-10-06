// pearson-tfl/llm_wiki#3: the startup-processing harness writes to the vault
// it is given, so it takes only a copy prove-on-copy.sh made.
const COPY_VAULT_RE = /\/run-[0-9]{8}T[0-9]{6}\/(baseline|vault|control)$/

export function assertCopyVault(path: string): void {
  if (!COPY_VAULT_RE.test(path)) throw new Error(`not a prove-on-copy.sh copy: ${path}`)
}
