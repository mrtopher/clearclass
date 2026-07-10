import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCohereRerank,
  rerankChunks,
  type RerankFn,
  type RerankResult,
} from "@/lib/retrieval/rerank";
import type { RetrievedChunk } from "@/lib/retrieval/dense";

/**
 * The rerank stage's contract: reorder the fused pool via the cross-encoder and
 * take top-k, BUT never crash — any failure (outage, missing key, timeout, bad
 * response) degrades to the incoming fused-hybrid order (the plan's edge
 * scenario). Pure orchestration over an injected `RerankFn` — no network, no key.
 */

const chunk = (id: number): RetrievedChunk => ({
  id,
  content: `chunk ${id}`,
  type: "hts",
  metadata: { hts_code: `code-${id}` },
  similarity: 0.5,
});

const fused = [chunk(1), chunk(2), chunk(3), chunk(4)];

/** A fake reranker that returns the given input-indices, best-first. */
const rankTo = (order: number[]): RerankFn =>
  vi.fn(async () => order.map((index, i) => ({ index, relevanceScore: 1 - i * 0.1 })));

describe("rerankChunks", () => {
  it("reorders the fused pool by the reranker's scores and truncates to topN", async () => {
    // Reranker says the best-matching chunks are (input idx) 2, 0 — i.e. chunk 3 then 1.
    const out = await rerankChunks("cotton shirt", fused, 2, { rerank: rankTo([2, 0, 3, 1]) });
    expect(out.map((c) => c.id)).toEqual([3, 1]);
  });

  it("passes the chunk CONTENTS and topN to the reranker", async () => {
    const rerank = rankTo([0, 1, 2, 3]);
    await rerankChunks("q", fused, 3, { rerank });
    expect(rerank).toHaveBeenCalledWith("q", ["chunk 1", "chunk 2", "chunk 3", "chunk 4"], { topN: 3 });
  });

  it("falls back to the fused order (truncated) when the reranker THROWS — no crash", async () => {
    const rerank: RerankFn = vi.fn(async () => {
      throw new Error("Cohere 503");
    });
    const out = await rerankChunks("q", fused, 3, { rerank });
    expect(out.map((c) => c.id)).toEqual([1, 2, 3]); // original fused order, first 3
  });

  it("falls back to the fused order when the reranker returns nothing usable", async () => {
    const out = await rerankChunks("q", fused, 2, { rerank: vi.fn(async () => [] as RerankResult[]) });
    expect(out.map((c) => c.id)).toEqual([1, 2]);
  });

  it("skips an out-of-range index so a bad response can't fabricate/duplicate a chunk", async () => {
    // index 9 doesn't exist; only 2 and 0 map to real chunks.
    const out = await rerankChunks("q", fused, 4, { rerank: rankTo([9, 2, 0]) });
    expect(out.map((c) => c.id)).toEqual([3, 1]);
  });

  it("returns [] for an empty pool without calling the reranker", async () => {
    const rerank = rankTo([]);
    expect(await rerankChunks("q", [], 3, { rerank })).toEqual([]);
    expect(rerank).not.toHaveBeenCalled();
  });

  it("keeps the fused order (no rerank) for a blank query", async () => {
    const rerank = rankTo([3, 2, 1, 0]);
    const out = await rerankChunks("   ", fused, 2, { rerank });
    expect(out.map((c) => c.id)).toEqual([1, 2]);
    expect(rerank).not.toHaveBeenCalled();
  });
});

describe("createCohereRerank", () => {
  const okBody = { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }] };
  const fakeResponse = (init: { ok: boolean; status?: number; json?: unknown; text?: string }) => ({
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    json: async () => init.json,
    text: async () => init.text ?? "",
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.COHERE_API_KEY;
  });

  it("posts query + documents to the Cohere endpoint with auth and coerces results", async () => {
    process.env.COHERE_API_KEY = "co-key";
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(fakeResponse({ ok: true, json: okBody })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await createCohereRerank()("cotton shirt", ["a", "b"], { topN: 2 });

    expect(out).toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.4 },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.cohere.com/v2/rerank");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer co-key");
    const sent = JSON.parse(init.body as string);
    expect(sent.query).toBe("cotton shirt");
    expect(sent.documents).toEqual(["a", "b"]);
    expect(sent.top_n).toBe(2);
    expect(typeof sent.model).toBe("string");
  });

  it("throws when COHERE_API_KEY is missing (caught upstream → fused fallback)", async () => {
    await expect(createCohereRerank()("q", ["a"], { topN: 1 })).rejects.toThrow(/COHERE_API_KEY not configured/);
  });

  it("throws on a non-OK HTTP status", async () => {
    process.env.COHERE_API_KEY = "co-key";
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ ok: false, status: 429, text: "rate limited" })));
    await expect(createCohereRerank()("q", ["a"], { topN: 1 })).rejects.toThrow(/Cohere HTTP 429: rate limited/);
  });

  it("coerces a missing relevance_score to 0 and drops a row without a numeric index", async () => {
    process.env.COHERE_API_KEY = "co-key";
    const body = { results: [{ index: 0 }, { relevance_score: 0.5 }] };
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ ok: true, json: body })));
    const out = await createCohereRerank()("q", ["a", "b"], { topN: 2 });
    expect(out).toEqual([{ index: 0, relevanceScore: 0 }]);
  });
});
