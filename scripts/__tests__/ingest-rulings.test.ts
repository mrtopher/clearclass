import { describe, expect, it } from "vitest";

import { parseArgs } from "@/scripts/ingest-rulings";

/**
 * Pins the ruling-ingest CLI scoping (WHERE it writes, HOW MANY it seeds). Like
 * ingest-hts, the fetch loop and file write are live I/O and remain untested;
 * the arg parsing decides run scope, so a regression here silently mis-scopes
 * the real ingest. The script guards `main()` behind an entrypoint check, so
 * importing it here triggers no network.
 */
describe("ingest-rulings parseArgs", () => {
  it("defaults to the canonical output path and the broadened 2000 target", () => {
    expect(parseArgs([])).toEqual({ out: "data/ruling-chunks.jsonl", target: 2000 });
  });

  it("parses --out and --target overrides", () => {
    expect(parseArgs(["--out=/tmp/r.jsonl", "--target=50"])).toEqual({
      out: "/tmp/r.jsonl",
      target: 50,
    });
  });

  it("throws on a non-positive or non-numeric target", () => {
    expect(() => parseArgs(["--target=0"])).toThrow(/Invalid --target/);
    expect(() => parseArgs(["--target=abc"])).toThrow(/Invalid --target/);
  });

  it("throws loudly on an unrecognized flag instead of a silent full run", () => {
    expect(() => parseArgs(["--targ=50"])).toThrow(/Unrecognized argument/);
  });
});
