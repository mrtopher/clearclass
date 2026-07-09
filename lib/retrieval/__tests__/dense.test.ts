import { describe, expect, it, vi } from "vitest";

import {
  clampK,
  denseRetrieve,
  toRetrievedChunk,
  DEFAULT_K,
  MAX_K,
  type DenseRetrieveDeps,
  type RetrievedChunk,
} from "@/lib/retrieval/dense";

/**
 * The dense retriever's contract: embed the query, cosine-search, return ranked
 * chunks — with a blank query short-circuiting BEFORE the (billable) embed, `k`
 * clamped to a sane range, and a malformed RPC row failing loudly rather than
 * becoming a half-built citation. The orchestration is dependency-injected, so
 * these tests use fake embed/search — no gateway, no database.
 */

const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id: 1,
  content: "Live horses",
  type: "hts",
  metadata: { hts_code: "0101.21.00.10" },
  similarity: 0.9,
  ...over,
});

const fakeDeps = (over: Partial<DenseRetrieveDeps> = {}): DenseRetrieveDeps => ({
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
  search: vi.fn(async () => [chunk()]),
  ...over,
});

describe("clampK", () => {
  it("passes a normal k through", () => {
    expect(clampK(5)).toBe(5);
  });
  it("floors to 1 and caps at MAX_K", () => {
    expect(clampK(0)).toBe(1);
    expect(clampK(-4)).toBe(1);
    expect(clampK(9999)).toBe(MAX_K);
  });
  it("truncates a fractional k", () => {
    expect(clampK(7.8)).toBe(7);
  });
  it("falls back to DEFAULT_K on a non-finite k (NaN, ±Infinity)", () => {
    expect(clampK(NaN)).toBe(DEFAULT_K);
    expect(clampK(Infinity)).toBe(DEFAULT_K);
    expect(clampK(-Infinity)).toBe(DEFAULT_K);
  });
});

describe("denseRetrieve", () => {
  it("embeds the trimmed query and searches with the clamped k and type", async () => {
    const deps = fakeDeps();
    const out = await denseRetrieve("  cotton t-shirt  ", { k: 3, type: "hts" }, deps);

    expect(deps.embed).toHaveBeenCalledWith("cotton t-shirt");
    expect(deps.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], { k: 3, type: "hts" });
    expect(out).toHaveLength(1);
    expect(out[0].metadata.hts_code).toBe("0101.21.00.10");
  });

  it("defaults k to DEFAULT_K and passes no type filter when omitted", async () => {
    const deps = fakeDeps();
    await denseRetrieve("knit shirt", {}, deps);
    expect(deps.search).toHaveBeenCalledWith([0.1, 0.2, 0.3], { k: DEFAULT_K, type: undefined });
  });

  it("clamps an over-large k before searching", async () => {
    const deps = fakeDeps();
    await denseRetrieve("q", { k: 1000 }, deps);
    expect(deps.search).toHaveBeenCalledWith(expect.anything(), { k: MAX_K, type: undefined });
  });

  it("short-circuits a blank query to [] WITHOUT embedding (edge: empty query)", async () => {
    const deps = fakeDeps();
    const out = await denseRetrieve("   ", { k: 5 }, deps);
    expect(out).toEqual([]);
    expect(deps.embed).not.toHaveBeenCalled();
    expect(deps.search).not.toHaveBeenCalled();
  });
});

describe("toRetrievedChunk", () => {
  it("accepts a well-formed RPC row", () => {
    expect(toRetrievedChunk(chunk(), "row 0").id).toBe(1);
  });

  it.each([
    ["not an object", 42, /expected a result row object/],
    ["missing id", { content: "x", type: "hts", metadata: {}, similarity: 0.1 }, /missing a numeric id/],
    ["missing content", { id: 1, type: "hts", metadata: {}, similarity: 0.1 }, /missing content/],
    ["missing type", { id: 1, content: "x", metadata: {}, similarity: 0.1 }, /missing type/],
    ["non-object metadata", { id: 1, content: "x", type: "hts", metadata: "no", similarity: 0.1 }, /metadata must be an object/],
    ["missing similarity", { id: 1, content: "x", type: "hts", metadata: {} }, /missing a numeric similarity/],
  ])("fails loudly on %s", (_label, value, pattern) => {
    expect(() => toRetrievedChunk(value, "rpc row 3")).toThrow(pattern as RegExp);
  });
});
