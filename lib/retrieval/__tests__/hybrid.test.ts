import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CANDIDATE_POOL,
  createFetchLexicalSearch,
  hybridRetrieve,
  reciprocalRankFusion,
  RRF_K,
  type HybridRetrieveDeps,
} from "@/lib/retrieval/hybrid";
import { MAX_K, type RetrievedChunk } from "@/lib/retrieval/dense";

/**
 * The hybrid arm's contract: run a dense + lexical search over a candidate pool
 * and fuse them by RANK POSITION (RRF), deterministically. A blank query
 * short-circuits before the billable embed; the lexical transport maps the RPC
 * rows like the dense one and fails loudly on a bad response. Pure fusion +
 * injected transports — no gateway, no DB.
 */

const chunk = (id: number, over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id,
  content: `chunk ${id}`,
  type: "hts",
  metadata: { hts_code: `code-${id}` },
  similarity: 0.5,
  ...over,
});

describe("reciprocalRankFusion", () => {
  it("ranks a chunk both lists agree on above one only a single list has", () => {
    // Chunk 2 is #2 in dense and #1 in lexical → highest combined RRF score.
    const dense = [chunk(1), chunk(2), chunk(3)];
    const lexical = [chunk(2), chunk(9)];
    const fused = reciprocalRankFusion([dense, lexical]);
    expect(fused[0].id).toBe(2);
    // All distinct ids are present, deduped.
    expect(new Set(fused.map((c) => c.id))).toEqual(new Set([1, 2, 3, 9]));
    expect(fused).toHaveLength(4);
  });

  it("keeps the FIRST-seen chunk object on a dup (dense wins over lexical)", () => {
    const denseTwo = chunk(2, { similarity: 0.91, content: "dense-2" });
    const lexTwo = chunk(2, { similarity: 0.11, content: "lex-2" });
    const fused = reciprocalRankFusion([[denseTwo], [lexTwo]]);
    expect(fused).toHaveLength(1);
    expect(fused[0].content).toBe("dense-2");
    expect(fused[0].similarity).toBe(0.91);
  });

  it("breaks a score tie by ascending id (fully deterministic)", () => {
    // Each chunk is rank 0 in exactly one list → identical RRF score.
    const fused = reciprocalRankFusion([[chunk(5)], [chunk(3)]]);
    expect(fused.map((c) => c.id)).toEqual([3, 5]);
  });

  it("uses 1/(k+rank) with the RRF_K constant", () => {
    // Single list, two items: scores are 1/(k+1) and 1/(k+2); order preserved.
    const fused = reciprocalRankFusion([[chunk(1), chunk(2)]], RRF_K);
    expect(fused.map((c) => c.id)).toEqual([1, 2]);
  });

  it("returns [] for no lists / empty lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe("hybridRetrieve", () => {
  const fakeDeps = (over: Partial<HybridRetrieveDeps> = {}): HybridRetrieveDeps => ({
    embed: vi.fn(async () => [0.1, 0.2, 0.3]),
    denseSearch: vi.fn(async () => [chunk(1), chunk(2)]),
    lexicalSearch: vi.fn(async () => [chunk(2), chunk(3)]),
    ...over,
  });

  it("embeds the trimmed query, runs both arms with the candidate pool, and fuses", async () => {
    const deps = fakeDeps();
    const out = await hybridRetrieve("  cotton shirt  ", { candidatePool: 12, type: "hts" }, deps);

    expect(deps.embed).toHaveBeenCalledWith("cotton shirt");
    expect(deps.denseSearch).toHaveBeenCalledWith([0.1, 0.2, 0.3], { k: 12, type: "hts" });
    // Lexical arm searches by TEXT (server builds the tsquery), not the embedding.
    expect(deps.lexicalSearch).toHaveBeenCalledWith("cotton shirt", { k: 12, type: "hts" });
    // Chunk 2 is in both arms → fused first; 1 and 3 follow.
    expect(out[0].id).toBe(2);
    expect(new Set(out.map((c) => c.id))).toEqual(new Set([1, 2, 3]));
  });

  it("defaults the candidate pool to CANDIDATE_POOL and passes no type filter", async () => {
    const deps = fakeDeps();
    await hybridRetrieve("knit shirt", {}, deps);
    expect(deps.denseSearch).toHaveBeenCalledWith(expect.anything(), { k: CANDIDATE_POOL, type: undefined });
    expect(deps.lexicalSearch).toHaveBeenCalledWith("knit shirt", { k: CANDIDATE_POOL, type: undefined });
  });

  it("clamps an over-large candidate pool to MAX_K before searching", async () => {
    const deps = fakeDeps();
    await hybridRetrieve("q", { candidatePool: 9999 }, deps);
    expect(deps.denseSearch).toHaveBeenCalledWith(expect.anything(), { k: MAX_K, type: undefined });
  });

  it("short-circuits a blank query to [] WITHOUT embedding or searching", async () => {
    const deps = fakeDeps();
    const out = await hybridRetrieve("   ", {}, deps);
    expect(out).toEqual([]);
    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.denseSearch).not.toHaveBeenCalled();
    expect(deps.lexicalSearch).not.toHaveBeenCalled();
  });
});

describe("createFetchLexicalSearch", () => {
  const cfg = { baseUrl: "https://db.example", apiKey: "admin-key" };
  const okBody = [
    { id: 1, content: "cotton knit shirt", type: "hts", metadata: { hts_code: "6110.20.20.10" }, similarity: 0.42 },
  ];
  const fakeResponse = (init: { ok: boolean; status?: number; json?: unknown; text?: string }) => ({
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    json: async () => init.json,
    text: async () => init.text ?? "",
  });

  afterEach(() => vi.unstubAllGlobals());

  it("posts the query TEXT to the lexical RPC and maps the rows", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(fakeResponse({ ok: true, json: okBody })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await createFetchLexicalSearch(cfg)("cotton shirt", { k: 20, type: "hts" });

    expect(out).toHaveLength(1);
    expect(out[0].metadata.hts_code).toBe("6110.20.20.10");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://db.example/api/database/rpc/match_documents_lexical");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer admin-key");
    expect(JSON.parse(init.body as string)).toEqual({
      query_text: "cotton shirt",
      match_count: 20,
      filter_type: "hts",
    });
  });

  it("sends filter_type:null when no type is given (search all sources)", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(fakeResponse({ ok: true, json: okBody })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await createFetchLexicalSearch(cfg)("shirt", { k: 5 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).filter_type).toBeNull();
  });

  it("throws on a non-OK HTTP status (does not swallow a PostgREST error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ ok: false, status: 500, text: "boom" })));
    await expect(createFetchLexicalSearch(cfg)("shirt", { k: 3 })).rejects.toThrow(
      /match_documents_lexical HTTP 500: boom/,
    );
  });

  it("throws on a non-array body rather than reading an error object as 'no matches'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse({ ok: true, json: { error: "nope" } })));
    await expect(createFetchLexicalSearch(cfg)("shirt", { k: 3 })).rejects.toThrow(/expected an array of rows/);
  });
});
