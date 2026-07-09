import { describe, expect, it, vi } from "vitest";

import { createRetrieveTool, toCitation, type RetrieveResult } from "@/lib/tools/retrieve";
import type { RetrievedChunk } from "@/lib/retrieval/dense";

/**
 * The tool's job is a thin, faithful projection: real chunk ids and the right
 * citation key per corpus type, so U6 can constrain the model to cite only what
 * was actually retrieved. Tests inject a fake retriever — no gateway, no DB.
 */

const hts: RetrievedChunk = {
  id: 10,
  content: "Live horses ... > Purebred breeding animals",
  type: "hts",
  metadata: { hts_code: "0101.21.00.10", chapter: "01" },
  similarity: 0.88,
};
const ruling: RetrievedChunk = {
  id: 20,
  content: "The tariff classification of a woman's shirt ...",
  type: "ruling",
  metadata: { ruling_number: "818731", hts_code: "6206.30.3010" },
  similarity: 0.71,
};
const gri: RetrievedChunk = {
  id: 30,
  content: "GRI 1 — classification is determined by the terms of the headings ...",
  type: "gri",
  metadata: { rule: "1", label: "GRI 1" },
  similarity: 0.6,
};

describe("toCitation", () => {
  it("carries the real id, content, similarity, and the HTS code", () => {
    expect(toCitation(hts)).toEqual({
      id: 10,
      type: "hts",
      content: hts.content,
      similarity: 0.88,
      hts_code: "0101.21.00.10",
      ruling_number: undefined,
      gri_rule: undefined,
    });
  });

  it("surfaces the ruling number (and its code) for a ruling chunk", () => {
    const c = toCitation(ruling);
    expect(c.ruling_number).toBe("818731");
    expect(c.hts_code).toBe("6206.30.3010");
    expect(c.gri_rule).toBeUndefined();
  });

  it("surfaces the GRI rule for a gri chunk and omits code fields", () => {
    const c = toCitation(gri);
    expect(c.gri_rule).toBe("1");
    expect(c.hts_code).toBeUndefined();
    expect(c.ruling_number).toBeUndefined();
  });
});

describe("createRetrieveTool", () => {
  // The AI SDK passes a ToolCallOptions second arg at runtime; tests don't need it.
  const opts = {} as never;

  it("returns citations and a count from the injected retriever (integration shape)", async () => {
    const retriever = vi.fn(async () => [hts, ruling]);
    const tool = createRetrieveTool(retriever);

    const result = (await tool.execute!({ query: "cotton t-shirt", k: 5, type: "hts" }, opts)) as RetrieveResult;

    expect(retriever).toHaveBeenCalledWith("cotton t-shirt", { k: 5, type: "hts" });
    expect(result.count).toBe(2);
    expect(result.chunks.map((c) => c.id)).toEqual([10, 20]);
    expect(result.chunks[1].ruling_number).toBe("818731");
  });

  it("returns an empty result (count 0) when the retriever finds nothing", async () => {
    const tool = createRetrieveTool(vi.fn(async () => []));
    const result = (await tool.execute!({ query: "   " }, opts)) as RetrieveResult;
    expect(result).toEqual({ count: 0, chunks: [] });
  });
});
