import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAdvancedRetriever,
  createConfiguredRetriever,
  DEFAULT_RETRIEVAL_MODE,
  resolveRetrievalMode,
  RETRIEVAL_MODES,
} from "@/lib/retrieval";
import { DEFAULT_K, type RetrievedChunk } from "@/lib/retrieval/dense";
import type { HybridRetriever } from "@/lib/retrieval/hybrid";
import type { RerankFn } from "@/lib/retrieval/rerank";

/**
 * The mode switch: `RETRIEVAL_MODE` selects the baseline vs the advanced arm, the
 * advanced arm composes fuse → rerank into a `DenseRetriever`-shaped function, and
 * the same query yields a DETERMINISTIC result (the plan's "flag changes results
 * deterministically" contract). Injected hybrid + rerank — no gateway, no DB.
 */

const chunk = (id: number): RetrievedChunk => ({
  id,
  content: `chunk ${id}`,
  type: "hts",
  metadata: { hts_code: `code-${id}` },
  similarity: 0.5,
});

describe("resolveRetrievalMode", () => {
  it("defaults to dense when the flag is unset/blank", () => {
    expect(resolveRetrievalMode(undefined)).toBe("dense");
    expect(resolveRetrievalMode("   ")).toBe("dense");
    expect(DEFAULT_RETRIEVAL_MODE).toBe("dense");
  });

  it("recognizes dense/baseline aliases (case-insensitive)", () => {
    expect(resolveRetrievalMode("dense")).toBe("dense");
    expect(resolveRetrievalMode("BASELINE")).toBe("dense");
  });

  it("recognizes the advanced arm and its aliases", () => {
    expect(resolveRetrievalMode("hybrid+rerank")).toBe("hybrid+rerank");
    expect(resolveRetrievalMode("hybrid")).toBe("hybrid+rerank");
    expect(resolveRetrievalMode(" Advanced ")).toBe("hybrid+rerank");
  });

  it("falls back to dense and WARNS on an unrecognized value (typo can't ship wrong arm)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveRetrievalMode("hybridd")).toBe("dense");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrecognized RETRIEVAL_MODE"));
    warn.mockRestore();
  });

  it("exposes both arms for the eval harness to iterate", () => {
    expect(RETRIEVAL_MODES).toEqual(["dense", "hybrid+rerank"]);
  });
});

describe("createAdvancedRetriever", () => {
  const fusedPool = [chunk(1), chunk(2), chunk(3)];
  const fakeHybrid: HybridRetriever = vi.fn(async () => fusedPool);

  it("fuses over the candidate pool then reranks to the requested final k", async () => {
    const hybrid: HybridRetriever = vi.fn(async () => fusedPool);
    // Reranker promotes fused index 2 (chunk 3) to the top.
    const rerank: RerankFn = vi.fn(async () => [
      { index: 2, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.5 },
      { index: 1, relevanceScore: 0.1 },
    ]);
    const retriever = createAdvancedRetriever({ hybrid, rerank, candidatePool: 25 });

    const out = await retriever("cotton shirt", { k: 2, type: "hts" });

    // Hybrid gets the candidate pool + type (NOT the final k).
    expect(hybrid).toHaveBeenCalledWith("cotton shirt", { candidatePool: 25, type: "hts" });
    // Reranked, then truncated to the final k=2.
    expect(out.map((c) => c.id)).toEqual([3, 1]);
  });

  it("uses DEFAULT_K as the final count when the caller omits k", async () => {
    const rerank: RerankFn = vi.fn(async (_q: string, docs: string[]) =>
      docs.map((_d, index) => ({ index, relevanceScore: 1 })),
    );
    await createAdvancedRetriever({ hybrid: fakeHybrid, rerank })("q");
    expect(rerank).toHaveBeenCalledWith("q", expect.any(Array), { topN: DEFAULT_K });
  });

  it("reorders the correct subheading above dense-only order, deterministically", async () => {
    // Dense-only would return the fused order as-is: [wrong=1, cotton=2].
    const hybrid: HybridRetriever = vi.fn(async () => [chunk(1), chunk(2)]);
    // The cross-encoder recognizes the exact "of cotton" match at fused index 1.
    const rerank: RerankFn = vi.fn(async () => [
      { index: 1, relevanceScore: 0.95 },
      { index: 0, relevanceScore: 0.30 },
    ]);
    const retriever = createAdvancedRetriever({ hybrid, rerank });

    const first = await retriever("garment of cotton", { k: 2 });
    const second = await retriever("garment of cotton", { k: 2 });

    expect(first.map((c) => c.id)).toEqual([2, 1]); // cotton promoted above the dense #1
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id)); // deterministic
  });

  it("degrades to fused order if the rerank transport fails (no crash)", async () => {
    const hybrid: HybridRetriever = vi.fn(async () => fusedPool);
    const rerank: RerankFn = vi.fn(async () => {
      throw new Error("Cohere down");
    });
    const out = await createAdvancedRetriever({ hybrid, rerank })("q", { k: 2 });
    expect(out.map((c) => c.id)).toEqual([1, 2]); // fused order preserved
  });
});

describe("createConfiguredRetriever", () => {
  afterEach(() => {
    delete process.env.RETRIEVAL_MODE;
  });

  it("returns a callable retriever for each mode without needing credentials at construction", () => {
    expect(typeof createConfiguredRetriever("dense")).toBe("function");
    expect(typeof createConfiguredRetriever("hybrid+rerank")).toBe("function");
  });

  it("selects the arm from RETRIEVAL_MODE when no explicit mode is given", () => {
    process.env.RETRIEVAL_MODE = "hybrid+rerank";
    // Construction must not throw; the resolved mode is exercised by the arm tests.
    expect(typeof createConfiguredRetriever()).toBe("function");
  });
});
