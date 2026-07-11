import { describe, expect, it, vi } from "vitest";

import {
  assertNoLeakage,
  findLeakage,
  toTestRows,
  type TestRow,
} from "@/eval/dataset";
import { LEAKAGE_SIMILARITY_THRESHOLD } from "@/lib/rulings";

/**
 * U10 dataset layer. Two things are integrity-critical and so are pinned here:
 *
 *  1. `toTestRows` — the ground truth must be trustworthy before ANY score is
 *     computed against it, so a malformed row is fatal, not silently coerced.
 *  2. `findLeakage` / `assertNoLeakage` — the AE4 guarantee. A leaked ruling in
 *     the retrievable corpus would let the model read back the answer key, so
 *     the assertion must FIRE on a same-product ruling and stay quiet on a
 *     genuinely different one. It reuses the exact ingest-time guard, so these
 *     tests also guard against that guard silently weakening.
 */

describe("toTestRows", () => {
  it("trims and passes through well-formed rows", () => {
    const rows = toTestRows([
      { description: "  cotton t-shirt ", gold_hts: " 6109.10.0040 " },
    ]);
    expect(rows).toEqual([{ description: "cotton t-shirt", gold_hts: "6109.10.0040" }]);
  });

  it("throws on a row missing a description, naming the row index", () => {
    expect(() => toTestRows([{ gold_hts: "6109.10.0040" }], "split.jsonl")).toThrow(
      /split\.jsonl row 1 is missing a description/,
    );
  });

  it("throws on a row missing a gold code", () => {
    expect(() => toTestRows([{ description: "cotton t-shirt" }])).toThrow(/missing a gold_hts/);
  });

  it("throws on a blank/whitespace-only field (not just absent)", () => {
    expect(() => toTestRows([{ description: "   ", gold_hts: "6109" }])).toThrow(
      /missing a description/,
    );
  });

  it("throws on an empty dataset rather than certifying a run over zero rows", () => {
    expect(() => toTestRows([])).toThrow(/has no rows/);
  });
});

describe("findLeakage (AE4 core)", () => {
  const TEST_DESCRIPTIONS = [
    "What is the HTS US Code for a woman's knit cotton t-shirt?",
    "What is the HTS US Code for a cast carbon steel pipe flange?",
  ];

  it("flags a retrievable ruling that describes the same product as a test row", () => {
    // Same product as test row 0, phrased the CROSS way — the leak vector.
    const subjects = ["The tariff classification of a woman's knit cotton T-shirt from China"];
    const violations = findLeakage(subjects, TEST_DESCRIPTIONS);
    expect(violations).toHaveLength(1);
    expect(violations[0].similarity).toBeGreaterThanOrEqual(LEAKAGE_SIMILARITY_THRESHOLD);
    expect(violations[0].testDescription).toContain("cotton t-shirt");
  });

  it("stays quiet on a ruling about a genuinely different product", () => {
    const subjects = ["The tariff classification of a lithium-ion laptop battery from Korea"];
    expect(findLeakage(subjects, TEST_DESCRIPTIONS)).toEqual([]);
  });

  it("skips empty/whitespace subjects without counting them as leaks", () => {
    expect(findLeakage(["", "   "], TEST_DESCRIPTIONS)).toEqual([]);
  });

  it("catches a verbose real-CROSS subject of a terse test product (containment, not just Jaccard)", () => {
    const subjects = [
      "The tariff classification of a woman's short-sleeve knit cotton t-shirt " +
        "with an embroidered chest logo and ribbed crew collar from Bangladesh",
    ];
    const violations = findLeakage(subjects, ["What is the HTS US Code for a cotton t-shirt?"]);
    expect(violations).toHaveLength(1);
  });

  it("respects a stricter/looser threshold override", () => {
    const subjects = ["The tariff classification of a woman's knit cotton T-shirt from China"];
    // An impossibly high threshold means nothing counts as a leak.
    expect(findLeakage(subjects, TEST_DESCRIPTIONS, 1.01)).toEqual([]);
  });
});

describe("assertNoLeakage", () => {
  const rows: TestRow[] = [
    { description: "What is the HTS US Code for a woman's knit cotton t-shirt?", gold_hts: "6109.10.0040" },
  ];

  it("reports zero violations and the count checked when the corpus is clean", async () => {
    const fetchSubjects = vi.fn().mockResolvedValue([
      "The tariff classification of a cast carbon steel pipe flange from Germany",
      "The tariff classification of a lithium-ion laptop battery from Korea",
    ]);
    const report = await assertNoLeakage(rows.map((r) => r.description), fetchSubjects);
    expect(report.checked).toBe(2);
    expect(report.violations).toEqual([]);
    expect(report.threshold).toBe(LEAKAGE_SIMILARITY_THRESHOLD);
  });

  it("surfaces the leaked ruling so the caller can abort the run", async () => {
    const fetchSubjects = vi.fn().mockResolvedValue([
      "The tariff classification of a woman's knit cotton T-shirt from Vietnam",
    ]);
    const report = await assertNoLeakage(rows.map((r) => r.description), fetchSubjects);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].subject).toContain("cotton");
  });

  it("REFUSES to certify a clean guard over zero rulings (fail closed on an empty read)", async () => {
    // The archetypal lying eval: a green checkmark that inspected nothing. An empty
    // corpus read (mislabelled type, not-yet-ingested, or a soft-failed proxy) must
    // throw, not return `{ violations: [] }`.
    const fetchSubjects = vi.fn().mockResolvedValue([]);
    await expect(assertNoLeakage(rows.map((r) => r.description), fetchSubjects)).rejects.toThrow(
      /zero retrievable rulings/,
    );
  });
});
