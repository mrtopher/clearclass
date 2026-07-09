import { describe, expect, it } from "vitest";

import {
  buildLeakageIndex,
  excludeLeakage,
  jaccard,
  normalizeProductText,
  parseDatasetRow,
  productSimilarity,
  roundRobinDedupe,
  toFallbackChunk,
  toRulingChunk,
  type DatasetRow,
  type RawCrossRuling,
  type RulingChunk,
} from "@/lib/rulings";

/**
 * U3 leakage guard (R2, AE4) — the integrity-critical core.
 *
 * The plan's original mechanism (intersect seeded ruling IDs with the eval
 * test-split ruling IDs) is infeasible: the public flexifyai mirror is a
 * chat-format dataset that carries NO ruling numbers. So leakage is enforced by
 * PRODUCT-DESCRIPTION SIMILARITY instead — a seeded CBP ruling is dropped when
 * its subject describes the same product as any test-split row. These tests pin
 * that behaviour with fixtures, and the final `describe` asserts the AE4
 * guarantee directly: after filtering, no surviving ruling matches a test-split
 * description above threshold (the "intersection is empty" invariant).
 */

/** A CROSS ruling whose subject is the SAME product as `TEST_DESCRIPTIONS[0]`,
 *  just phrased the CROSS way ("The tariff classification of ... from ..."). */
const LEAKED_RULING: RawCrossRuling = {
  rulingNumber: "N123456",
  subject: "The tariff classification of a woman's knit cotton T-shirt from China",
  tariffs: ["6109.10.0040"],
  rulingDate: "2019-05-01T00:00:00",
  collection: "ny",
};

/** A CROSS ruling about a completely unrelated product — must survive. */
const CLEAN_RULING: RawCrossRuling = {
  rulingNumber: "H987654",
  subject: "The tariff classification of a cast carbon steel pipe flange from Germany",
  tariffs: ["7307.19.9060"],
  rulingDate: "2020-02-02T00:00:00",
  collection: "hq",
};

/** Test-split product descriptions, in the mirror's "What is the HTS..." phrasing. */
const TEST_DESCRIPTIONS = [
  "What is the HTS US Code for a woman's knit cotton t-shirt?",
  "What is the HTS US Code for a lithium-ion battery pack for a laptop computer?",
];

describe("normalizeProductText", () => {
  it("strips the mirror's question wrapper and CROSS boilerplate to the product core", () => {
    const a = normalizeProductText("What is the HTS US Code for a woman's knit cotton t-shirt?");
    const b = normalizeProductText(
      "The tariff classification of a woman's knit cotton T-shirt from China",
    );
    // Both should reduce to the same content words (order-independent).
    expect(a).toContain("cotton");
    expect(a).toContain("shirt");
    expect(a).not.toContain("hts");
    expect(a).not.toContain("code");
    expect(b).not.toContain("classification");
    expect(b).not.toContain("china");
  });

  it("is idempotent", () => {
    const once = normalizeProductText("The tariff classification of steel pipe fittings from Italy");
    expect(normalizeProductText(once)).toBe(once);
  });

  it("strips a trailing COUNTRY origin clause but preserves a trailing MATERIAL clause", () => {
    // "from <country>" is origin noise -> dropped.
    expect(normalizeProductText("cotton sweater from Vietnam").split(" ")).not.toContain("vietnam");
    // "from <material>" is discriminative -> kept (regression: the old greedy
    // strip deleted it, which could let a leaked ruling slip the guard).
    const jam = normalizeProductText("strawberry jam made from concentrate");
    expect(jam).toContain("concentrate");
    expect(jam).toContain("strawberry");
  });

  it("preserves country-homograph product nouns (turkey, china, chile)", () => {
    // These are in COUNTRY_WORDS only to gate the origin strip; as product
    // nouns they must survive so two different products stay distinguishable.
    expect(normalizeProductText("smoked turkey breast")).toContain("turkey");
    expect(normalizeProductText("fine china dinnerware")).toContain("china");
  });

  it("normalizes hyphenation and plurals so variants collapse to one token", () => {
    // "t-shirt"/"tshirt" and "shirts"/"shirt" should not sink a true match.
    const a = new Set(normalizeProductText("men's t-shirts").split(" "));
    const b = new Set(normalizeProductText("mens tshirt").split(" "));
    expect(a).toEqual(b);
  });
});

describe("jaccard", () => {
  it("is 1 for identical sets and 0 for disjoint sets", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it("is the intersection-over-union in between", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(2 / 4);
  });
});

describe("productSimilarity", () => {
  it("scores same-product / differently-phrased descriptions high", () => {
    const s = productSimilarity(
      "What is the HTS US Code for a woman's knit cotton t-shirt?",
      "The tariff classification of a woman's knit cotton T-shirt from China",
    );
    expect(s).toBeGreaterThan(0.5);
  });

  it("scores unrelated products low", () => {
    const s = productSimilarity(
      "What is the HTS US Code for a woman's knit cotton t-shirt?",
      "The tariff classification of a cast carbon steel pipe flange from Germany",
    );
    expect(s).toBeLessThan(0.5);
  });

  it("still scores high when the SAME product's ruling subject is verbose (containment, not just Jaccard)", () => {
    // A terse test description vs a padded real-CROSS subject of the same
    // product: symmetric Jaccard alone would fall below 0.5 (the leak vector);
    // containment keeps it high because the test tokens are fully covered.
    const s = productSimilarity(
      "What is the HTS US Code for a cotton t-shirt?",
      "The tariff classification of a woman's short-sleeve knit cotton t-shirt " +
        "with an embroidered chest logo, ribbed crew collar, and screen-printed " +
        "back graphic from China",
    );
    expect(s).toBeGreaterThanOrEqual(0.5);
  });
});

describe("toRulingChunk", () => {
  it("normalizes a raw CROSS ruling into a tagged, citable chunk", () => {
    const chunk = toRulingChunk(CLEAN_RULING);
    expect(chunk).not.toBeNull();
    expect(chunk!.type).toBe("ruling");
    expect(chunk!.metadata.ruling_number).toBe("H987654");
    expect(chunk!.metadata.hts_code).toBe("7307.19.9060");
    expect(chunk!.metadata.date).toBe("2020-02-02");
    expect(chunk!.content).toContain("pipe flange");
    // The ruling number is materialized into the content so a retrieved chunk
    // is self-citing without a metadata round-trip.
    expect(chunk!.content).toContain("H987654");
  });

  it("returns null for a ruling with no assigned tariff (nothing to classify against)", () => {
    expect(toRulingChunk({ ...CLEAN_RULING, tariffs: [] })).toBeNull();
    expect(toRulingChunk({ ...CLEAN_RULING, tariffs: null })).toBeNull();
  });

  it("returns null for a ruling with an empty subject (no product text to embed)", () => {
    expect(toRulingChunk({ ...CLEAN_RULING, subject: "   " })).toBeNull();
  });

  it("leaves a non-10-digit tariff code as-is (trimmed) instead of mis-dotting it", () => {
    // Only a full 10-digit code is canonicalized to 4.2.4 form; a 6-digit or
    // otherwise-short code is a valid (if less specific) citation and must not
    // be reshaped into a wrong dotted form.
    const short = toRulingChunk({ ...CLEAN_RULING, tariffs: ["  6109.10  "] });
    expect(short!.metadata.hts_code).toBe("6109.10");
  });
});

describe("roundRobinDedupe", () => {
  const mk = (n: string): RawCrossRuling => ({
    rulingNumber: n,
    subject: `subject ${n}`,
    tariffs: ["1234.56.7890"],
    rulingDate: "2020-01-01T00:00:00",
    collection: "ny",
  });

  it("interleaves across buckets so early buckets do not dominate the head", () => {
    const buckets = [
      [mk("A1"), mk("A2"), mk("A3")],
      [mk("B1"), mk("B2")],
      [mk("C1")],
    ];
    // One from each bucket per depth, in order: A1,B1,C1, A2,B2, A3.
    expect(roundRobinDedupe(buckets, 10).map((r) => r.rulingNumber)).toEqual([
      "A1", "B1", "C1", "A2", "B2", "A3",
    ]);
  });

  it("dedupes by ruling number and honors the limit", () => {
    const buckets = [[mk("A1"), mk("dup")], [mk("dup"), mk("B2")]];
    const out = roundRobinDedupe(buckets, 3);
    expect(out.map((r) => r.rulingNumber)).toEqual(["A1", "dup", "B2"]);
    expect(roundRobinDedupe(buckets, 2)).toHaveLength(2);
  });

  it("returns empty for all-empty buckets (the total-CROSS-outage case)", () => {
    expect(roundRobinDedupe([[], []], 10)).toEqual([]);
  });
});

describe("parseDatasetRow", () => {
  const row: DatasetRow = {
    messages: [
      { role: "user", content: "What is the HTS US Code for a woman's knit cotton t-shirt?" },
      {
        role: "assistant",
        content: "HTS US Code -> 6109.10.0040\nReasoning -> Knit cotton apparel of heading 6109.",
      },
    ],
  };

  it("extracts the description, canonicalized gold code, and reasoning", () => {
    const parsed = parseDatasetRow(row);
    expect(parsed).not.toBeNull();
    expect(parsed!.description).toBe("What is the HTS US Code for a woman's knit cotton t-shirt?");
    expect(parsed!.gold_hts).toBe("6109.10.0040");
    expect(parsed!.reasoning).toMatch(/heading 6109/);
  });

  it("returns null when the assistant turn has no parseable code", () => {
    expect(
      parseDatasetRow({
        messages: [
          { role: "user", content: "What is the code for a widget?" },
          { role: "assistant", content: "I am not sure." },
        ],
      }),
    ).toBeNull();
  });
});

describe("toFallbackChunk", () => {
  it("builds a ruling chunk with a synthetic id that flags degraded provenance", () => {
    const chunk = toFallbackChunk(
      { description: "a woman's cotton t-shirt", gold_hts: "6109.10.0040", reasoning: "knit apparel" },
      7,
    );
    expect(chunk.type).toBe("ruling");
    expect(chunk.metadata.ruling_number).toBe("FLEXIFYAI-00007");
    expect(chunk.metadata.collection).toBe("flexifyai-fallback");
    expect(chunk.metadata.hts_code).toBe("6109.10.0040");
    expect(chunk.metadata.subject_raw).toBe("a woman's cotton t-shirt");
    expect(chunk.content).toMatch(/fallback seed/i);
  });

  it("stays subject to the same leakage guard (subject_raw drives exclusion)", () => {
    const index = buildLeakageIndex([
      "What is the HTS US Code for a woman's knit cotton t-shirt?",
    ]);
    const leaked = toFallbackChunk(
      { description: "a woman's knit cotton t-shirt", gold_hts: "6109.10.0040", reasoning: "" },
      1,
    );
    expect(excludeLeakage([leaked], index).dropped).toHaveLength(1);
  });
});

describe("excludeLeakage", () => {
  const index = buildLeakageIndex(TEST_DESCRIPTIONS);

  it("drops a ruling that describes the same product as a test-split row", () => {
    const chunks = [toRulingChunk(LEAKED_RULING)!, toRulingChunk(CLEAN_RULING)!];
    const { kept, dropped } = excludeLeakage(chunks, index);
    expect(dropped.map((c) => c.metadata.ruling_number)).toEqual(["N123456"]);
    expect(kept.map((c) => c.metadata.ruling_number)).toEqual(["H987654"]);
  });

  it("keeps everything when nothing matches the test split", () => {
    const chunks = [toRulingChunk(CLEAN_RULING)!];
    expect(excludeLeakage(chunks, index).kept).toHaveLength(1);
  });

  // AE4, proven by DISCRIMINATION, not tautology. The earlier version of this
  // test re-asserted `similarity(kept, test) < threshold` using the same
  // function excludeLeakage filters with, so survivors passed by construction —
  // it proved self-consistency, not leak-freedom. These cases instead feed the
  // guard rulings whose phrasing diverges from the test split and assert the
  // right ones are dropped / kept.
  it("drops a same-product ruling even when its real-CROSS subject is verbose", () => {
    // The test split has a terse "cotton t-shirt"; the seeded ruling is the same
    // product padded with descriptive clauses. This is the leak vector that
    // symmetric Jaccard alone would miss — the guard must still drop it.
    const verboseTee: RawCrossRuling = {
      rulingNumber: "N555001",
      subject:
        "The tariff classification of a woman's short-sleeve knit cotton t-shirt " +
        "with embroidered chest logo and ribbed collar from Bangladesh",
      tariffs: ["6109.10.0040"],
      rulingDate: "2018-04-04T00:00:00",
      collection: "ny",
    };
    const idx = buildLeakageIndex(["What is the HTS US Code for a cotton t-shirt?"]);
    expect(excludeLeakage([toRulingChunk(verboseTee)!], idx).dropped).toHaveLength(1);
  });

  it("keeps a genuinely different product that only shares a generic word", () => {
    // "steel pipe flange" vs a test item about a "steel water bottle": they
    // share only "steel"; the guard must NOT over-exclude this real precedent.
    const idx = buildLeakageIndex(["What is the HTS US Code for a steel water bottle?"]);
    const kept = excludeLeakage([toRulingChunk(CLEAN_RULING)!], idx).kept;
    expect(kept).toHaveLength(1);
  });
});
