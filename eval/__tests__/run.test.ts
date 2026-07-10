import { describe, expect, it } from "vitest";

import { parseArgs } from "@/eval/run";

/**
 * `parseArgs` is the only pure surface of the orchestrator (the rest is gateway/
 * DB I/O), and it gates real spend — a misparsed `--recall-only` or `--modes`
 * could silently launch the expensive full run, so its defaults and validation
 * are pinned here.
 */
describe("parseArgs", () => {
  it("defaults to both modes, all recall rows, and sampled expensive suites", () => {
    const args = parseArgs([]);
    expect(args.modes).toEqual(["dense", "hybrid+rerank"]);
    expect(args.limit).toBeNull();
    expect(args.e2eLimit).toBe(25);
    expect(args.ragLimit).toBe(10);
    expect(args.recallOnly).toBe(false);
    expect(args.out).toBe("eval/report.md");
  });

  it("parses --recall-only and a single --modes value", () => {
    const args = parseArgs(["--recall-only", "--modes=dense"]);
    expect(args.recallOnly).toBe(true);
    expect(args.modes).toEqual(["dense"]);
  });

  it("accepts the hybrid aliases and dedupes modes", () => {
    expect(parseArgs(["--modes=advanced,hybrid"]).modes).toEqual(["hybrid+rerank"]);
    expect(parseArgs(["--modes=baseline,dense"]).modes).toEqual(["dense"]);
  });

  it("parses the full-run limits and a custom k list", () => {
    const args = parseArgs(["--e2e-limit=200", "--rag-limit=40", "--k=1,5,10"]);
    expect(args.e2eLimit).toBe(200);
    expect(args.ragLimit).toBe(40);
    expect(args.ks).toEqual([1, 5, 10]);
  });

  it("rejects an unknown flag and an invalid mode / integer", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/Unrecognized argument/);
    expect(() => parseArgs(["--modes=bogus"])).toThrow(/Invalid --modes/);
    expect(() => parseArgs(["--e2e-limit=0"])).toThrow(/positive integer/);
  });

  it("rejects value-less --k / --modes with a friendly error, not an opaque TypeError", () => {
    expect(() => parseArgs(["--k"])).toThrow(/--k requires a value/);
    expect(() => parseArgs(["--modes"])).toThrow(/--modes requires a value/);
  });
});
