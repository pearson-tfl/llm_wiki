/**
 * An in-memory stand-in for the Tauri vector-store and embedding commands,
 * for tests that route `@tauri-apps/api/core`'s `invoke` through it. Rows
 * are kept per page id as the Rust v2 table keeps them; the embedding is a
 * deterministic bag of words, so a search for a phrase finds the chunks
 * that hold its words.
 */

interface StoredChunk {
  chunk_index: number
  chunk_text: string
  heading_path: string
  embedding: number[]
}

const DIM = 1024

export function fakeEmbedding(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    vector[h % DIM] += 1
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map((v) => v / norm)
}

export function createFakeVectorStore() {
  const pages = new Map<string, StoredChunk[]>()
  // `hung`: while set, an embedding request for text holding `matching`
  // waits on `until`, as on an endpoint that never answers.
  const state = {
    endpointDown: false,
    hung: null as { matching: string; until: Promise<void> } | null,
  }
  async function answer(texts: string[]): Promise<void> {
    if (state.hung && texts.some((t) => t.includes(state.hung!.matching))) await state.hung.until
    if (state.endpointDown) throw new Error("connection refused")
  }
  const calls: { cmd: string; args: Record<string, unknown> }[] = []

  async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    calls.push({ cmd, args })
    switch (cmd) {
      case "embedding_fetch":
        await answer([String(args.text)])
        return fakeEmbedding(String(args.text))
      case "embedding_fetch_batch":
        await answer(args.texts as string[])
        return (args.texts as string[]).map(fakeEmbedding)
      case "vector_upsert_chunks": {
        const chunks = args.chunks as StoredChunk[]
        if (chunks.length > 0) pages.set(String(args.pageId), chunks)
        return null
      }
      case "vector_delete_page":
        pages.delete(String(args.pageId))
        return null
      case "vector_list_page_ids":
        return [...pages.keys()].sort()
      case "vector_count_chunks":
        return [...pages.values()].reduce((n, rows) => n + rows.length, 0)
      case "vector_optimize_chunks":
        return null
      case "vector_search_chunks": {
        const query = args.queryEmbedding as number[]
        const hits = [...pages.entries()].flatMap(([pageId, rows]) =>
          rows.map((row) => {
            const distance = Math.hypot(...row.embedding.map((v, i) => v - query[i]))
            return {
              chunk_id: `${pageId}#${row.chunk_index}`,
              page_id: pageId,
              chunk_index: row.chunk_index,
              chunk_text: row.chunk_text,
              heading_path: row.heading_path,
              score: 1 / (1 + distance),
            }
          }),
        )
        return hits.sort((a, b) => b.score - a.score).slice(0, Number(args.topK))
      }
      default:
        throw new Error(`fake vector store: unexpected command ${cmd}`)
    }
  }

  return { pages, state, calls, invoke }
}
