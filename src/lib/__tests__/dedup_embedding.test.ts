/**
 * dedup_embedding.test.ts — unit tests for #359 prefilter (R4)
 */
import { describe, it, expect, vi } from "vitest"
import {
  candidatePairs,
  clusterByPairs,
  cosineSimilarity,
  pageToEmbeddingText,
  type Page,
} from "../dedup_embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"

// Mock fetchEmbedding to produce realistic, sparse vectors.
// Strategy: numeric id suffix → topic axis (mod dim). Pages with same
// numeric suffix share a topic (e.g. p1 and q1 both on axis 1), but
// consecutive ids (p0, p1, p2, ...) land on consecutive axes → low mutual
// similarity. This mirrors real-world embeddings where distinct topics
// have distinct dominant axes.
vi.mock("../embedding", () => ({
  fetchEmbedding: vi.fn(async (text: string) => {
    const dim = 64
    const v = new Array(dim).fill(0)
    // Extract numeric portion from the input text (pageId is first line)
    const idLine = text.split("\n")[0] ?? ""
    const numMatch = idLine.match(/\d+/)
    const num = numMatch ? parseInt(numMatch[0], 10) : 0
    const topicAxis = num % dim
    v[topicAxis] = 1.0
    v[(topicAxis + 1) % dim] = 0.05
    v[(topicAxis - 1 + dim) % dim] = 0.03
    return v
  }),
}))

const testCfg: EmbeddingConfig = {
  enabled: true,
  endpoint: "http://localhost:0/v1/embeddings",
  apiKey: "mock-key",
  model: "mock-embedder",
}

const page = (id: string, title: string, body = ""): Page => ({
  id, title, body, tags: [],
})

describe('pageToEmbeddingText', () => {
  it('concatenates title + tags + body', () => {
    const text = pageToEmbeddingText({
      id: "p1", title: "Foo", body: "bar baz", tags: ["a", "b"],
    })
    expect(text).toBe("p1\nFoo\na b\nbar baz")
  })

  it('truncates body at budget', () => {
    const longBody = "x".repeat(2000)
    const text = pageToEmbeddingText({ id: "p2", title: "T", body: longBody }, 100)
    expect(text.length).toBeLessThan(120)
    expect(text).toContain("x".repeat(100))
  })

  it('handles empty tags and body', () => {
    expect(pageToEmbeddingText({ id: "p3", title: "Solo" })).toBe("p3\nSolo")
  })
})

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0, 5);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0, 5);
  });
  it('returns 0 for null vectors', () => {
    expect(cosineSimilarity(null, [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], null)).toBe(0);
  });
  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });
});

describe('candidatePairs', () => {
  it('returns empty array for empty input', async () => {
    expect(await candidatePairs([], testCfg)).toEqual([]);
  });

  it('returns empty for single page (self-exclusion)', async () => {
    expect(await candidatePairs([page('a', 'Foo')], testCfg)).toEqual([]);
  });

  it('generates symmetric, deduplicated pairs', async () => {
    // p11 and q11 share axis 11 → high sim
    const pages = [
      page('p11', 'Foo bar baz'),
      page('q11', 'completely different topic'),
      page('p12', 'yet another topic'),
      page('q12', 'totally unrelated'),
    ];
    const pairs = await candidatePairs(pages, testCfg, { threshold: 0.8 });
    expect(pairs.every(([x, y]) => x !== y)).toBe(true);
    const keys = pairs.map(([x, y]) => x < y ? `${x}|${y}` : `${y}|${x}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('respects threshold filter (higher threshold → fewer pairs)', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => page(`p${i}`, `t${i}`));
    const high = await candidatePairs(pages, testCfg, { threshold: 0.99 });
    const low  = await candidatePairs(pages, testCfg, { threshold: 0.5 });
    expect(low.length).toBeGreaterThanOrEqual(high.length);
  });

  it('respects topK (caps total pairs at topK * n)', async () => {
    // With numeric-id mock: p0..p19 → distinct axes 0..19.
    // topK=3 means each page iteration contributes AT MOST 3 NEW pairs to pairSet.
    // Worst case: each iteration adds 3 NEW pairs → max = topK * n = 60.
    const pages = Array.from({ length: 20 }, (_, i) => page(`p${i}`, `t${i}`));
    const pairs = await candidatePairs(pages, testCfg, { threshold: 0.0, topK: 3 });
    expect(pairs.length).toBeLessThanOrEqual(60);
  });

  it('scales to 1000 pages with realistic output (acceptance for #359)', async () => {
    // 1000 pages with ids p0..p999 → 64 distinct axes (15-16 pages per axis).
    // Acceptance: <3000 candidate pairs (300× reduction vs R1's N² baseline).
    const pages = Array.from({ length: 1000 }, (_, i) => page(`p${i}`, `s${i}`));
    const t0 = Date.now();
    const pairs = await candidatePairs(pages, testCfg, { threshold: 0.95, topK: 3 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5000);
    expect(pairs.length).toBeLessThan(3000);
    expect(pairs.length).toBeGreaterThan(0); // sanity: dedup actually ran
  });

  it('skips pages whose embedding returns null', async () => {
    // Override mock for this test only: make p1 and p2 fail embedding
    const { fetchEmbedding } = await import('../embedding');
    const origFetch = (fetchEmbedding as any).getMockImplementation();
    (fetchEmbedding as any).mockImplementationOnce(async () => null); // p1
    (fetchEmbedding as any).mockImplementationOnce(async () => null); // p2
    (fetchEmbedding as any).mockImplementationOnce(async () => [1, 0]); // p3 axis 0
    (fetchEmbedding as any).mockImplementationOnce(async () => [1, 0]); // p3 dup axis 0

    try {
      const pages = [
        page('p1', 'A'),
        page('p2', 'B'),
        page('p3', 'C'),
        page('p4', 'D'),
      ];
      // p3 and p4 both have id-axes → high sim → should pair
      const pairs = await candidatePairs(pages, testCfg, {
        minSuccessRatio: 0.5,
        threshold: 0.5,
      });
      // null embeddings: p1 and p2 won't contribute as SOURCE; may still appear as TARGET
      // but no pairs should reference them since no other page has a vector to compare
      expect(pairs.every(([a, b]) => a !== 'p1' && b !== 'p1' && a !== 'p2' && b !== 'p2')).toBe(true);
    } finally {
      (fetchEmbedding as any).mockImplementation(origFetch);
    }
  });

  it("throws when too few pages embed successfully", async () => {
    const { fetchEmbedding } = await import("../embedding");
    const origFetch = (fetchEmbedding as any).getMockImplementation();
    (fetchEmbedding as any).mockImplementation(async () => null);

    await expect(
      candidatePairs(
        [page("p1", "A"), page("p2", "B"), page("p3", "C")],
        testCfg,
      ),
    ).rejects.toThrow(/could not embed enough pages|embedded only/i);

    (fetchEmbedding as any).mockImplementation(origFetch);
  });

  it("throws when most pages fail to embed", async () => {
    const { fetchEmbedding } = await import("../embedding");
    const origFetch = (fetchEmbedding as any).getMockImplementation();
    (fetchEmbedding as any)
      .mockImplementationOnce(async () => [1, 0])
      .mockImplementationOnce(async () => [1, 0])
      .mockImplementation(async () => null);

    await expect(
      candidatePairs(
        [
          page("p1", "A"),
          page("p2", "B"),
          page("p3", "C"),
          page("p4", "D"),
        ],
        testCfg,
      ),
    ).rejects.toThrow(/embedded only 2\/4/i);

    (fetchEmbedding as any).mockImplementation(origFetch);
  });

  it("honors an already-aborted signal before embedding work starts", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      candidatePairs(
        [page("p1", "A"), page("p2", "B")],
        testCfg,
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled/i);
  });

  it("embeds and compares every page of a wiki over 5,000 pages (#116)", async () => {
    const { fetchEmbedding } = await import("../embedding");
    const origFetch = (fetchEmbedding as any).getMockImplementation();
    // A zero vector embeds but matches nothing, so only the last two pages,
    // past the old 5,000-page cap, can pair.
    (fetchEmbedding as any).mockImplementation(async (text: string) =>
      /^(late|twin)\n/.test(text) ? [1, 0] : [0, 0],
    );
    (fetchEmbedding as any).mockClear();

    const pages = [
      ...Array.from({ length: 5000 }, (_, i) => page(`p${i}`, `t${i}`)),
      page("late", "Late"),
      page("twin", "Twin"),
    ];
    const pairs = await candidatePairs(pages, testCfg);

    expect((fetchEmbedding as any).mock.calls).toHaveLength(5002);
    expect(pairs).toEqual([["late", "twin"]]);

    (fetchEmbedding as any).mockImplementation(origFetch);
  });
});

describe("the compare (#122)", () => {
  /** Each page's vector by page id: the stub embeds the id on the text's first line. */
  async function stubVectors(vectors: Map<string, number[] | null>) {
    const { fetchEmbedding } = await import("../embedding");
    const origFetch = (fetchEmbedding as any).getMockImplementation();
    (fetchEmbedding as any).mockImplementation(async (text: string) =>
      vectors.get(text.split("\n")[0]) ?? null,
    );
    (fetchEmbedding as any).mockClear();
    return {
      embedCalls: () => (fetchEmbedding as any).mock.calls.length as number,
      restore: () => (fetchEmbedding as any).mockImplementation(origFetch),
    };
  }

  /** A clock that moves a second on every read, so every slice of the compare runs out. */
  function slowClock() {
    let now = 0;
    return vi.spyOn(performance, "now").mockImplementation(() => (now += 1000));
  }

  const axisPages = (n: number) => {
    const vectors = new Map<string, number[] | null>();
    for (let i = 0; i < n; i++) vectors.set(`p${i}`, i % 2 === 0 ? [1, 0] : [0.9, 0.1]);
    return { vectors, pages: [...vectors.keys()].map((id) => page(id, id)) };
  };

  it("hands the main thread back during the compare", async () => {
    const { vectors, pages } = axisPages(6);
    const stub = await stubVectors(vectors);
    const clock = slowClock();
    try {
      // The stub embeds without a timer, so the timer can only run once the
      // compare hands the thread back.
      let embeddedWhenTimerRan = -1;
      setTimeout(() => { embeddedWhenTimerRan = stub.embedCalls(); }, 0);

      await candidatePairs(pages, testCfg, { threshold: 0.5 });

      expect(embeddedWhenTimerRan).toBe(pages.length);
    } finally {
      clock.mockRestore();
      stub.restore();
    }
  });

  it("stops the compare when the scan is cancelled during it", async () => {
    const { vectors, pages } = axisPages(6);
    const stub = await stubVectors(vectors);
    const clock = slowClock();
    try {
      const controller = new AbortController();
      let embeddedWhenCancelled = -1;
      setTimeout(() => {
        embeddedWhenCancelled = stub.embedCalls();
        controller.abort();
      }, 0);

      await expect(
        candidatePairs(pages, testCfg, { threshold: 0.5, signal: controller.signal }),
      ).rejects.toThrow(/cancelled/i);
      expect(embeddedWhenCancelled).toBe(pages.length);
    } finally {
      clock.mockRestore();
      stub.restore();
    }
  });

  it("reads each vector once for its length and once for each pair", async () => {
    const dim = 4;
    const n = 6;
    const reads = new Map<string, number>();
    const vectors = new Map<string, number[] | null>();
    for (let i = 0; i < n; i++) {
      const id = `p${i}`;
      reads.set(id, 0);
      const values = Array.from({ length: dim }, (_, k) => (k === i % dim ? 1 : 0.1));
      vectors.set(id, new Proxy(values, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads.set(id, reads.get(id)! + 1);
          return Reflect.get(target, key, receiver);
        },
      }));
    }
    const stub = await stubVectors(vectors);
    try {
      await candidatePairs([...vectors.keys()].map((id) => page(id, id)), testCfg, { threshold: 0.5 });
    } finally {
      stub.restore();
    }

    // Before #122 each pair was scored from both sides, each score reading
    // both vectors three times: 6 * (n - 1) * dim reads per vector.
    for (const [id, count] of reads) {
      expect(count, id).toBe(dim + (n - 1) * dim);
    }
  });

  /** The compare as it was before #122, kept to check the results did not change. */
  function pairsBefore122(
    pages: Page[],
    embeddings: Map<string, number[] | null>,
    topK: number,
    threshold: number,
  ): Array<readonly [string, string]> {
    const cosine = (a: number[] | null | undefined, b: number[] | null | undefined) => {
      if (!a || !b || a.length !== b.length) return 0;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      const denom = Math.sqrt(na) * Math.sqrt(nb);
      return denom === 0 ? 0 : dot / denom;
    };
    const pairSet = new Set<string>();
    const pairs: Array<readonly [string, string]> = [];
    for (let i = 0; i < pages.length; i++) {
      const vi = embeddings.get(pages[i].id);
      if (!vi) continue;
      const scored: Array<{ j: number; sim: number }> = [];
      for (let j = 0; j < pages.length; j++) {
        if (i === j) continue;
        const sim = cosine(vi, embeddings.get(pages[j].id));
        if (sim >= threshold) scored.push({ j, sim });
      }
      scored.sort((a, b) => b.sim - a.sim);
      for (let k = 0; k < Math.min(topK, scored.length); k++) {
        const a = pages[i].id;
        const b = pages[scored[k].j].id;
        const key = a < b ? `${a}\t${b}` : `${b}\t${a}`;
        if (!pairSet.has(key)) {
          pairSet.add(key);
          pairs.push([a, b] as const);
        }
      }
    }
    return pairs;
  }

  it("finds the same pairs, in the same order, as the compare before #122", async () => {
    // A seeded generator, so a failure can be replayed.
    let seed = 122;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const dim = 8;
    const vectors = new Map<string, number[] | null>();
    for (let i = 0; i < 80; i++) {
      const id = `p${i}`;
      const kind = i % 10;
      if (kind === 0) vectors.set(id, null); // failed embedding
      else if (kind === 1) vectors.set(id, new Array(dim).fill(0)); // zero vector
      else if (kind === 2) vectors.set(id, [1, 0, 0]); // another length
      else if (kind === 3 && i > 10) vectors.set(id, vectors.get(`p${i - 10}`)!); // a twin: tied scores
      // Coarse values, so many pairs tie on score.
      else vectors.set(id, Array.from({ length: dim }, () => Math.round(random() * 4) - 1));
    }
    const pages = [...vectors.keys()].map((id) => page(id, id));
    const stub = await stubVectors(vectors);
    try {
      for (const threshold of [0, 0.3, 0.68, 0.9]) {
        for (const topK of [1, 3, 8, 100]) {
          const got = await candidatePairs(pages, testCfg, { threshold, topK, minSuccessRatio: 0 });
          expect(got, `threshold ${threshold}, topK ${topK}`)
            .toEqual(pairsBefore122(pages, vectors, topK, threshold));
        }
      }
    } finally {
      stub.restore();
    }
  });
});

describe('clusterByPairs', () => {
  it('returns empty for no pairs', () => {
    expect(clusterByPairs(['a','b'], [])).toEqual([]);
  });

  it('groups transitive duplicates', () => {
    const groups = clusterByPairs(['a','b','c'], [['a','b'], ['b','c']]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['a','b','c']);
  });

  it('keeps isolated pages separate', () => {
    const groups = clusterByPairs(['a','b','c'], [['a','b']]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['a','b']);
  });

  it('handles 10k page IDs without stack overflow (R1 review Major)', () => {
    const ids = Array.from({ length: 10000 }, (_, i) => `id${i}`);
    const pairs: Array<readonly [string, string]> = [];
    for (let i = 0; i < 5000; i++) {
      pairs.push([`id${i}`, `id${i + 1}`] as const);
    }
    expect(() => clusterByPairs(ids, pairs)).not.toThrow();
    const groups = clusterByPairs(ids, pairs);
    expect(groups.length).toBe(1);
  });
});
