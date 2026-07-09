import { describe, expect, it } from "vitest";

import {
  chunkCodes,
  cleanQuery,
  codeDigits,
  formatRecallTable,
  isImplausiblyLow,
  matchesAtDigits,
  parseArgs,
  rowHitAtK,
  summarizeRecall,
  IMPLAUSIBLY_LOW_RECALL,
  type RecallResult,
  type RowResult,
} from "@/eval/retrieval-recall";
import type { RetrievedChunk } from "@/lib/retrieval/dense";

/**
 * The recall metric is the plan's earliest quantitative signal on chunking
 * quality, so its scoring logic is unit-tested precisely: digits-only code
 * matching (formats differ across corpus vs gold), top-k slicing, digit
 * granularity, and the implausibly-low alarm.
 */

describe("cleanQuery", () => {
  it("strips the dataset's 'What is the HTS US Code for ...?' framing", () => {
    expect(cleanQuery("What is the HTS US Code for cast carbon steel fittings made to ASTM A216?"))
      .toBe("cast carbon steel fittings made to ASTM A216");
  });
  it("handles the 'tariff classification of' phrasing and preserves case/content", () => {
    expect(cleanQuery("What is the tariff classification of a woman's knit cotton shirt?"))
      .toBe("a woman's knit cotton shirt");
  });
  it("leaves a bare product description untouched", () => {
    expect(cleanQuery("men's cotton knit t-shirt")).toBe("men's cotton knit t-shirt");
  });
  it("falls back to the original when stripping would empty the query", () => {
    expect(cleanQuery("What is the HTS code for?")).not.toBe("");
  });
});

describe("codeDigits", () => {
  it("strips dots so differently-formatted codes compare equal", () => {
    expect(codeDigits("0101.21.00.10")).toBe("0101210010");
    expect(codeDigits("7307.19.9060")).toBe("7307199060");
  });
});

describe("chunkCodes", () => {
  const chunk = (metadata: Record<string, unknown>): RetrievedChunk => ({
    id: 1, content: "x", type: "ruling", metadata, similarity: 0.5,
  });
  it("pulls hts_code and each entry of hts_codes[]", () => {
    expect(chunkCodes(chunk({ hts_code: "6206.30.3010", hts_codes: ["6206.30.3010", "6206.40.0000"] })))
      .toEqual(["6206.30.3010", "6206.30.3010", "6206.40.0000"]);
  });
  it("returns [] for a GRI chunk with no codes", () => {
    expect(chunkCodes(chunk({ rule: "1" }))).toEqual([]);
  });
  it("ignores non-string entries in hts_codes", () => {
    expect(chunkCodes(chunk({ hts_codes: ["7307.19.9060", 42, null] }))).toEqual(["7307.19.9060"]);
  });
});

describe("matchesAtDigits", () => {
  it("matches on the first N digits regardless of formatting", () => {
    expect(matchesAtDigits("6109.10.0012", "6109.10.0040", 6)).toBe(true); // same subheading
    expect(matchesAtDigits("6109.10.0012", "6109.10.0040", 10)).toBe(false); // differ at 10-digit
  });
  it("is a miss when either code is shorter than N digits", () => {
    expect(matchesAtDigits("6109", "6109.10.0040", 6)).toBe(false);
  });
});

describe("rowHitAtK", () => {
  // ranks: 0 -> ch61, 1 -> ch99 noise, 2 -> exact gold
  const ranked = [["6205.20.0000"], ["9999.99.9999"], ["6109.10.0040"]];
  const gold = "6109.10.0040";

  it("hits at 10-digit only once k reaches the exact-code rank", () => {
    expect(rowHitAtK(ranked, gold, 2, 10)).toBe(false); // top-2 misses it
    expect(rowHitAtK(ranked, gold, 3, 10)).toBe(true); // top-3 includes it
  });
  it("caps k at the number of retrieved chunks", () => {
    expect(rowHitAtK(ranked, gold, 100, 10)).toBe(true);
  });
  it("counts a gold code too short for the digit level as a miss", () => {
    expect(rowHitAtK([["6109.10.0040"]], "6109", 5, 6)).toBe(false);
  });
});

describe("summarizeRecall", () => {
  const rows: RowResult[] = [
    { gold: "6109.10.0040", rankedCodes: [["6109.10.0040"]] }, // hit @ k>=1, both digit levels
    { gold: "7307.19.9060", rankedCodes: [["9999.99.9999"], ["7307.19.0000"]] }, // 6-digit hit only @ k>=2
  ];
  it("computes recall per (k, digit) cell", () => {
    const results = summarizeRecall(rows, [1, 2], [6, 10]);
    const at = (k: number, d: number) => results.find((r) => r.k === k && r.digits === d)!.recall;
    expect(at(1, 6)).toBe(0.5); // only row 1 hits in top-1
    expect(at(2, 6)).toBe(1.0); // row 2's 6-digit match appears at rank 2
    expect(at(1, 10)).toBe(0.5);
    expect(at(2, 10)).toBe(0.5); // row 2 never matches at full 10 digits
  });
});

describe("isImplausiblyLow", () => {
  const r = (k: number, digits: number, recall: number): RecallResult => ({
    k, digits, recall, hits: 0, total: 100,
  });
  it("flags when the best coarse-digit recall is below the floor", () => {
    expect(isImplausiblyLow([r(5, 6, 0.05), r(10, 6, 0.1), r(10, 10, 0.02)])).toBe(true);
  });
  it("passes when a coarse-digit cell clears the floor", () => {
    expect(isImplausiblyLow([r(5, 6, 0.1), r(10, 6, IMPLAUSIBLY_LOW_RECALL + 0.4), r(10, 10, 0.3)])).toBe(false);
  });
  it("treats an empty result set as implausibly low", () => {
    expect(isImplausiblyLow([])).toBe(true);
  });
});

describe("formatRecallTable", () => {
  it("renders a digits × k grid", () => {
    const table = formatRecallTable(summarizeRecall(
      [{ gold: "6109.10.0040", rankedCodes: [["6109.10.0040"]] }],
      [5, 10],
      [6, 10],
    ));
    expect(table.split("\n")[0]).toBe("digits\tk=5\tk=10");
    expect(table).toContain("6\t1.000\t1.000");
  });
});

describe("parseArgs", () => {
  it("defaults to the full split, k=5,10,20, 6/10-digit", () => {
    expect(parseArgs([])).toEqual({
      split: "data/eval-test-split.jsonl", ks: [5, 10, 20], digits: [6, 10], limit: null,
    });
  });
  it("parses --limit, --k, --digits (dedup + sorted)", () => {
    expect(parseArgs(["--limit=25", "--k=10,5,10", "--digits=10,6"])).toEqual({
      split: "data/eval-test-split.jsonl", ks: [5, 10], digits: [6, 10], limit: 25,
    });
  });
  it("rejects a non-positive --limit and an unknown flag", () => {
    expect(() => parseArgs(["--limit=0"])).toThrow(/Invalid --limit/);
    expect(() => parseArgs(["--nope=1"])).toThrow(/Unrecognized argument/);
  });
});
