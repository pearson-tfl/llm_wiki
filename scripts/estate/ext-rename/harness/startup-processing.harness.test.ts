// pearson-tfl/llm_wiki#3 harness, run by prove-on-copy.sh. It feeds the
// change tasks the app's Rust startup comparison produced for a vault copy
// into the app's own startup processing (startProjectFileSync), with only the
// Tauri boundary replaced: file commands act on the copy through Node's fs,
// and the ingest queue and the embedding store are recorded, not run.
// Skipped unless EXT_RENAME_VAULT is set.
import fs from "node:fs"
import nodePath from "node:path"
import { describe, expect, it, vi } from "vitest"
import { assertCopyVault } from "./copy-vault"

const env = process.env

const record = vi.hoisted(() => ({
  enqueueBatch: [] as unknown[],
  removePageEmbedding: [] as string[],
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}))

vi.mock("@/commands/file-sync", () => ({
  startProjectFileWatcher: vi.fn(async () => ({
    queue: { version: 1, tasks: [] },
    changedTasks: JSON.parse(fs.readFileSync(env.EXT_RENAME_TASKS as string, "utf8")),
  })),
  stopProjectFileWatcher: vi.fn(async () => undefined),
  rescanProjectFiles: vi.fn(async () => ({ queue: { version: 1, tasks: [] }, changedTasks: [] })),
  invalidateProjectFileSnapshotPaths: vi.fn(async () => undefined),
}))

// list_directory in src-tauri/src/commands/fs.rs: folders first, then by
// name; dot-entries only on request; an empty folder has no children.
function listTree(dir: string, includeHidden: boolean): unknown[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => includeHidden || !e.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return entries.map((e) => {
    const path = nodePath.join(dir, e.name)
    const children = e.isDirectory() ? listTree(path, includeHidden) : []
    return { name: e.name, path, is_dir: e.isDirectory(), children: children.length ? children : undefined }
  })
}

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(async (path: string) => fs.readFileSync(path, "utf8")),
  writeFile: vi.fn(async (path: string, contents: string) => {
    fs.mkdirSync(nodePath.dirname(path), { recursive: true })
    fs.writeFileSync(path, contents)
  }),
  deleteFile: vi.fn(async (path: string) => {
    if (!fs.existsSync(path)) throw new Error(`no such file: ${path}`)
    fs.rmSync(path, { recursive: true })
  }),
  fileExists: vi.fn(async (path: string) => fs.existsSync(path)),
  listDirectory: vi.fn(async (path: string, opts: boolean | { includeHidden?: boolean } = false) => {
    if (!fs.existsSync(path)) throw new Error(`Path does not exist: '${path}'`)
    return listTree(path, typeof opts === "boolean" ? opts : Boolean(opts.includeHidden))
  }),
  getFileSize: vi.fn(async (path: string) => fs.statSync(path).size),
  preprocessFile: vi.fn(async (path: string) => path),
  findRelatedWikiPages: vi.fn(async () => []),
}))

vi.mock("@/lib/ingest-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ingest-queue")>()),
  enqueueBatch: vi.fn(async (...args: unknown[]) => {
    record.enqueueBatch.push(args)
    return []
  }),
}))

vi.mock("@/lib/embedding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/embedding")>()),
  removePageEmbedding: vi.fn(async (_project: string, id: string) => {
    record.removePageEmbedding.push(id)
  }),
}))

vi.mock("@/lib/project-file-tree-refresh", () => ({
  refreshProjectFileTree: vi.fn(async () => undefined),
}))

vi.mock("@/lib/source-lifecycle", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/source-lifecycle")>()
  return {
    ...real,
    migrateSourcePath: vi.fn(real.migrateSourcePath),
    deleteSourceFiles: vi.fn(real.deleteSourceFiles),
    enqueueSourceIngest: vi.fn(real.enqueueSourceIngest),
    cleanupDeletedWikiPages: vi.fn(real.cleanupDeletedWikiPages),
  }
})

describe.skipIf(!env.EXT_RENAME_VAULT)("app startup processing on a vault copy", () => {
  it("records what the app does with the startup changes", async () => {
    const { startProjectFileSync } = await import("@/lib/project-file-sync")
    const lifecycle = await import("@/lib/source-lifecycle")
    const { useWikiStore } = await import("@/stores/wiki-store")
    const { useFileSyncStore } = await import("@/stores/file-sync-store")

    const vault = env.EXT_RENAME_VAULT as string
    assertCopyVault(vault)
    const project = { id: env.EXT_RENAME_PROJECT_ID as string, name: "vault copy", path: vault }
    useWikiStore.getState().setProject(project as never)
    const config = JSON.parse(env.EXT_RENAME_WATCH_CONFIG as string)

    await startProjectFileSync(project as never, config)

    const calls = (fn: unknown) => (fn as { mock: { calls: unknown[][] } }).mock.calls
    const report = {
      migrateSourcePath: calls(lifecycle.migrateSourcePath).map((c) => [c[1], c[2]]),
      deleteSourceFiles: calls(lifecycle.deleteSourceFiles).map((c) => c[1]),
      enqueueSourceIngest: calls(lifecycle.enqueueSourceIngest).map((c) => c[1]),
      cleanupDeletedWikiPages: calls(lifecycle.cleanupDeletedWikiPages).map((c) => c[1]),
      enqueueBatch: record.enqueueBatch.length,
      removePageEmbedding: record.removePageEmbedding,
      lastError: useFileSyncStore.getState().lastError,
    }
    fs.writeFileSync(env.EXT_RENAME_REPORT as string, JSON.stringify(report, null, 2))
    expect(report.lastError).toBeNull()
  },
  // The app walks every wiki page for each move: minutes on a real vault.
  600_000)
})
