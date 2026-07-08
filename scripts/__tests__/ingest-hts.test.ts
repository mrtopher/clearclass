import { describe, expect, it } from "vitest";
import { chapterHeadingRange, parseArgs, range } from "@/scripts/ingest-hts";

/**
 * Covers the pure, zero-I/O helpers of the ingestion script. The network fetch
 * loop and file write remain intentionally untested (live I/O), but the arg
 * parsing and chapter-range math decide WHAT gets fetched and WHERE it is
 * written — a regression here silently mis-scopes the real run, so it is worth
 * pinning. (The script guards its own `main()` behind an entrypoint check, so
 * importing it here does not trigger a fetch.)
 */

describe("range", () => {
  it("is inclusive on both ends", () => {
    expect(range(1, 3)).toEqual([1, 2, 3]);
    expect(range(5, 5)).toEqual([5]);
  });
});

describe("parseArgs", () => {
  it("defaults to all 99 chapters and the canonical output path", () => {
    const { chapters, out } = parseArgs([]);
    expect(chapters).toEqual(range(1, 99));
    expect(chapters).toHaveLength(99);
    expect(out).toBe("data/hts-chunks.jsonl");
  });

  it("parses an explicit --chapters subset", () => {
    expect(parseArgs(["--chapters=61,62"]).chapters).toEqual([61, 62]);
  });

  it("parses an --out override", () => {
    expect(parseArgs(["--out=/tmp/hts.jsonl"]).out).toBe("/tmp/hts.jsonl");
  });

  it("throws on a non-numeric or out-of-range chapter", () => {
    expect(() => parseArgs(["--chapters=abc"])).toThrow(/Invalid --chapters/);
    expect(() => parseArgs(["--chapters=0"])).toThrow(/Invalid --chapters/);
    expect(() => parseArgs(["--chapters=100"])).toThrow(/Invalid --chapters/);
  });

  it("throws loudly on an unrecognized flag (e.g. a typo) instead of a silent full run", () => {
    expect(() => parseArgs(["--chpaters=61"])).toThrow(/Unrecognized argument/);
  });
});

describe("chapterHeadingRange", () => {
  it("zero-pads single-digit chapters and spans the whole chapter", () => {
    expect(chapterHeadingRange(1)).toEqual({ from: "0101", to: "0199" });
  });

  it("handles two-digit chapters", () => {
    expect(chapterHeadingRange(99)).toEqual({ from: "9901", to: "9999" });
  });
});
