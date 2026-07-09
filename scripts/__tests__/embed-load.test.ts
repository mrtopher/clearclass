import { describe, expect, it, vi } from "vitest";

import {
  assertChunk,
  batch,
  loadCorpus,
  parseArgs,
  toRows,
  type CorpusChunk,
  type DocumentRow,
  type LoadDeps,
} from "@/scripts/embed-load";

/**
 * U4's load contract is "all-or-loudly-nothing": embeddings must line up 1:1
 * with chunks, every batch must persist exactly what it was handed, and the
 * grand total must match the corpus size. The pure core is dependency-injected
 * so these tests exercise that contract with fake embed/insert functions — no
 * network, no database. The live similarity spot-check is the script's runtime
 * verification, not a unit test.
 */

const chunk = (content: string, type = "hts"): CorpusChunk => ({
  content,
  type,
  metadata: { hts_code: "0000.00.00.00" },
});

/** A fake embedder: one deterministic 3-dim vector per input, order-preserving. */
const fakeEmbed = (texts: string[]): Promise<number[][]> =>
  Promise.resolve(texts.map((_, i) => [i, i + 1, i + 2]));

describe("batch", () => {
  it("splits into groups of at most `size`, last group short", () => {
    expect(batch([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns a single group when size >= length", () => {
    expect(batch([1, 2], 10)).toEqual([[1, 2]]);
  });

  it("returns no groups for an empty input", () => {
    expect(batch([], 3)).toEqual([]);
  });

  it("rejects a non-positive size rather than looping forever", () => {
    expect(() => batch([1], 0)).toThrow(/size must be >= 1/);
  });
});

describe("assertChunk", () => {
  it("accepts a well-formed chunk", () => {
    expect(assertChunk(chunk("Live horses"), "x:1").content).toBe("Live horses");
  });

  it.each([
    ["empty content", { content: "  ", type: "hts", metadata: {} }, /empty or non-string content/],
    ["missing type", { content: "ok", metadata: {} }, /missing or non-string type/],
    ["non-object metadata", { content: "ok", type: "hts", metadata: "no" }, /metadata must be an object/],
    ["not an object", 42, /expected a chunk object/],
  ])("fails loudly on %s", (_label, value, pattern) => {
    expect(() => assertChunk(value, "corpus.jsonl:7")).toThrow(pattern as RegExp);
  });
});

describe("toRows", () => {
  it("zips chunks with embeddings positionally and stamps the model used", () => {
    const rows = toRows([chunk("a"), chunk("b")], [[1, 1, 1], [2, 2, 2]], "test-model");
    expect(rows).toEqual<DocumentRow[]>([
      { content: "a", embedding: [1, 1, 1], embedding_model: "test-model", type: "hts", metadata: { hts_code: "0000.00.00.00" } },
      { content: "b", embedding: [2, 2, 2], embedding_model: "test-model", type: "hts", metadata: { hts_code: "0000.00.00.00" } },
    ]);
  });

  it("throws when embedding count != chunk count (no misattributed vectors)", () => {
    expect(() => toRows([chunk("a"), chunk("b")], [[1, 1, 1]], "m")).toThrow(
      /embedding count 1 != chunk count 2/,
    );
  });
});

describe("loadCorpus", () => {
  it("embeds and inserts every chunk across batches (count in == count out)", async () => {
    const chunks = Array.from({ length: 5 }, (_, i) => chunk(`c${i}`));
    const insert = vi.fn((rows: DocumentRow[]) => Promise.resolve(rows.length));
    const deps: LoadDeps = { embed: fakeEmbed, insert };

    const result = await loadCorpus(chunks, deps, 2);

    expect(result).toEqual({ embedded: 5, inserted: 5 });
    // 5 chunks / batch 2 -> 3 insert calls (2, 2, 1).
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert.mock.calls.map((c) => c[0].length)).toEqual([2, 2, 1]);
  });

  it("attaches the right embedding to each row within a batch", async () => {
    const captured: DocumentRow[] = [];
    const deps: LoadDeps = {
      embed: fakeEmbed,
      insert: (rows) => {
        captured.push(...rows);
        return Promise.resolve(rows.length);
      },
    };
    await loadCorpus([chunk("x"), chunk("y")], deps, 10, "model-xyz");
    expect(captured[0].embedding).toEqual([0, 1, 2]);
    expect(captured[1].embedding).toEqual([1, 2, 3]);
    expect(captured.every((r) => r.embedding_model === "model-xyz")).toBe(true);
  });

  it("throws when a batch inserts fewer rows than sent (silent-drop guard)", async () => {
    const deps: LoadDeps = {
      embed: fakeEmbed,
      insert: (rows) => Promise.resolve(rows.length - 1), // pretend one row dropped
    };
    await expect(loadCorpus([chunk("a"), chunk("b")], deps, 2)).rejects.toThrow(
      /inserted 1 of 2 rows/,
    );
  });

  it("propagates an embed failure loudly rather than loading a partial corpus", async () => {
    const deps: LoadDeps = {
      embed: () => Promise.reject(new Error("gateway 503")),
      insert: () => Promise.resolve(0),
    };
    await expect(loadCorpus([chunk("a")], deps, 2)).rejects.toThrow(/gateway 503/);
  });
});

describe("parseArgs", () => {
  it("defaults to the three canonical corpora, batch 64, truncate on for a full run", () => {
    const args = parseArgs([]);
    expect(args.batchSize).toBe(64);
    expect(args.truncate).toBe(true);
    expect(args.limit).toBeNull();
    expect(args.files).toHaveLength(3);
  });

  it("parses --limit, --batch, and --no-truncate", () => {
    const args = parseArgs(["--limit=20", "--batch=8", "--no-truncate"]);
    expect(args).toMatchObject({ limit: 20, batchSize: 8, truncate: false });
  });

  it("does NOT truncate on a subset run by default (data-loss footgun guard)", () => {
    expect(parseArgs(["--limit=20"]).truncate).toBe(false);
  });

  it("honors an explicit --truncate even with --limit", () => {
    expect(parseArgs(["--limit=20", "--truncate"]).truncate).toBe(true);
  });

  it("rejects an unrecognized flag rather than silently ignoring it", () => {
    expect(() => parseArgs(["--btch=8"])).toThrow(/Unrecognized argument/);
  });

  it("rejects a non-positive --batch", () => {
    expect(() => parseArgs(["--batch=0"])).toThrow(/Invalid --batch/);
  });
});
