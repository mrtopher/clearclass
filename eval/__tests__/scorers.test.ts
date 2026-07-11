import { describe, expect, it } from "vitest";

import {
  headlineRecallLift,
  outcomeHit,
  renderReport,
  summarizeAccuracy,
  toOutcome,
  type ClassificationOutcome,
  type ReportData,
} from "@/eval/scorers";
import type { ClassificationResult } from "@/lib/schema";

/**
 * The deterministic accuracy scorer and the report renderer are pure, so they
 * are pinned exhaustively here — a wrong digit-level rule or a flipped delta sign
 * would silently misstate the Task-5/6 result a live run costs real money to
 * produce.
 */

const outcome = (gold: string, ...codes: string[]): ClassificationOutcome => ({
  gold,
  rankedCodes: codes,
});

describe("toOutcome", () => {
  it("projects a classification's ranked candidates, best-first", () => {
    const result = {
      candidates: [
        { hts_code: "6109.10.0040" },
        { hts_code: "6110.20.2010" },
        { hts_code: "6205.20.2020" },
      ],
    } as ClassificationResult;
    expect(toOutcome(result, "6109.10.0040").rankedCodes).toEqual([
      "6109.10.0040",
      "6110.20.2010",
      "6205.20.2020",
    ]);
  });
});

describe("outcomeHit", () => {
  it("top-1 hits only when the rank-1 candidate matches", () => {
    const o = outcome("6109.10.0040", "6110.20.2010", "6109.10.0040", "6205.20.2020");
    expect(outcomeHit(o, "top1", 10)).toBe(false); // gold is at rank 2
    expect(outcomeHit(o, "top3", 10)).toBe(true); // ...but present in top-3
  });

  it("top-1 hits at 10-digit when the best pick is exact", () => {
    const o = outcome("6109.10.0040", "6109.10.0040", "x", "y");
    expect(outcomeHit(o, "top1", 10)).toBe(true);
  });

  it("matches on digits only, ignoring dotting differences", () => {
    const o = outcome("6109.10.0040", "6109100040");
    expect(outcomeHit(o, "top1", 10)).toBe(true);
  });

  it("a coarser digit level forgives a differing tail", () => {
    const o = outcome("6109.10.0040", "6109.10.9999");
    expect(outcomeHit(o, "top1", 10)).toBe(false); // full code differs
    expect(outcomeHit(o, "top1", 6)).toBe(true); // 610910 matches
    expect(outcomeHit(o, "top1", 4)).toBe(true); // 6109 matches
  });

  it("counts a gold code shorter than the digit level as a miss", () => {
    const o = outcome("6109", "6109.10.0040");
    expect(outcomeHit(o, "top1", 10)).toBe(false);
    expect(outcomeHit(o, "top1", 4)).toBe(true);
  });
});

describe("summarizeAccuracy", () => {
  it("aggregates hits per (metric, digits) across rows", () => {
    const outcomes = [
      outcome("6109.10.0040", "6109.10.0040", "a", "b"), // top1 & top3 hit at all levels
      outcome("6110.20.2010", "9999.99.9999", "6110.20.2010", "c"), // top3 hit only
    ];
    const results = summarizeAccuracy(outcomes, ["top1", "top3"], [10]);
    const top1 = results.find((r) => r.metric === "top1" && r.digits === 10)!;
    const top3 = results.find((r) => r.metric === "top3" && r.digits === 10)!;
    expect(top1.hits).toBe(1);
    expect(top1.accuracy).toBe(0.5);
    expect(top3.hits).toBe(2);
    expect(top3.accuracy).toBe(1);
  });

  it("reports zero accuracy (not NaN) for an empty outcome set", () => {
    const results = summarizeAccuracy([], ["top1"], [10]);
    expect(results[0].accuracy).toBe(0);
    expect(results[0].total).toBe(0);
  });
});

// ── Report rendering ───────────────────────────────────────────────────────────

const baseReport = (over: Partial<ReportData> = {}): ReportData => ({
  generatedAt: "2026-07-10T00:00:00.000Z",
  datasetSize: 200,
  e2eSampleSize: 25,
  ragSampleSize: 10,
  ks: [5, 20],
  recallDigits: [6, 10],
  accuracyDigits: [10, 6, 4],
  leakage: { checked: 300, threshold: 0.5, violations: [] },
  recall: [
    {
      mode: "dense",
      scored: 200,
      errors: 0,
      results: [
        { k: 5, digits: 6, hits: 100, total: 200, recall: 0.5 },
        { k: 20, digits: 6, hits: 120, total: 200, recall: 0.6 },
        { k: 5, digits: 10, hits: 70, total: 200, recall: 0.35 },
        { k: 20, digits: 10, hits: 90, total: 200, recall: 0.45 },
      ],
    },
    {
      mode: "hybrid+rerank",
      scored: 200,
      errors: 0,
      results: [
        { k: 5, digits: 6, hits: 130, total: 200, recall: 0.65 },
        { k: 20, digits: 6, hits: 150, total: 200, recall: 0.75 },
        { k: 5, digits: 10, hits: 100, total: 200, recall: 0.5 },
        { k: 20, digits: 10, hits: 120, total: 200, recall: 0.6 },
      ],
    },
  ],
  accuracy: [],
  rag: [],
  ...over,
});

describe("renderReport", () => {
  it("leads with a clean AE4 verdict when there are no violations", () => {
    const md = renderReport(baseReport());
    expect(md).toMatch(/## AE4 — leakage guard/);
    expect(md).toMatch(/✅ \*\*Clean\.\*\* 300 retrievable ruling/);
    // AE4 section precedes the recall section.
    expect(md.indexOf("AE4")).toBeLessThan(md.indexOf("Retrieval recall@k"));
  });

  it("renders a red AE4 verdict and lists the leaked rulings", () => {
    const md = renderReport(
      baseReport({
        leakage: {
          checked: 300,
          threshold: 0.5,
          violations: [
            { subject: "a woman's knit cotton t-shirt", testDescription: "cotton t-shirt", similarity: 0.83 },
          ],
        },
      }),
    );
    expect(md).toMatch(/❌ \*\*LEAKAGE DETECTED\*\*/);
    expect(md).toMatch(/knit cotton t-shirt/);
    expect(md).toMatch(/INVALID/);
  });

  it("puts recall@k before accuracy, per the Execution note", () => {
    const md = renderReport(baseReport());
    expect(md.indexOf("Retrieval recall@k")).toBeLessThan(
      md.indexOf("End-to-end classification accuracy"),
    );
  });

  it("records the Task-6.3 re-selection arm when set, and omits it otherwise", () => {
    expect(renderReport(baseReport())).not.toMatch(/Agent re-selection/);
    expect(renderReport(baseReport({ reselect: true }))).toMatch(/Agent re-selection.*`ON`/);
    expect(renderReport(baseReport({ reselect: false }))).toMatch(/Agent re-selection.*`off`/);
  });

  it("shows a signed positive delta where the advanced arm beats the baseline", () => {
    const md = renderReport(baseReport());
    // dense r@5 ≥6-digit = 50.0%, advanced = 65.0% → +15.0 pts.
    expect(md).toMatch(/recall@5 \(≥6-digit\) \| 50\.0% \| 65\.0% \| \+15\.0 pts/);
  });

  it("summarizes the single largest recall lift as the headline", () => {
    const md = renderReport(baseReport());
    // Largest gain is r@5 ≥10-digit and r@20 ≥6-digit both +15; first found wins.
    expect(md).toMatch(/\*\*Headline:\*\* hybrid\+rerank moves recall@/);
  });

  it("falls back gracefully for unrun suites and omits the caveat when e2e did not run", () => {
    const md = renderReport(baseReport());
    expect(md).toMatch(/_End-to-end suite not run in this pass\._/);
    expect(md).toMatch(/_RAG-metrics suite not run in this pass\._/);
    // The n-scaled caveat is meaningless with no e2e sample, so it is suppressed.
    expect(md).not.toMatch(/Confidence caveat/);
  });

  it("renders accuracy and RAG comparison tables (and the caveat) when those suites ran", () => {
    const md = renderReport(
      baseReport({
        accuracy: [
          {
            mode: "dense",
            scored: 25,
            errors: 0,
            results: [{ metric: "top1", digits: 10, hits: 10, total: 25, accuracy: 0.4 }],
          },
          {
            mode: "hybrid+rerank",
            scored: 25,
            errors: 0,
            results: [{ metric: "top1", digits: 10, hits: 12, total: 25, accuracy: 0.48 }],
          },
        ],
        accuracyDigits: [10],
        rag: [
          { mode: "dense", scored: 10, scores: [{ name: "Faithfulness", score: 0.8 }] },
          { mode: "hybrid+rerank", scored: 10, scores: [{ name: "Faithfulness", score: 0.85 }] },
        ],
      }),
    );
    expect(md).toMatch(/top-1 exact \(≥10-digit\) \| 40\.0% \| 48\.0% \| \+8\.0 pts/);
    expect(md).toMatch(/Faithfulness \| 80\.0% \| 85\.0% \| \+5\.0 pts/);
    expect(md).toMatch(/Confidence caveat/);
    expect(md).toMatch(/25 row\(s\) scored per mode/);
  });

  it("renders the accuracy and RAG tables for an advanced-only run (no dense baseline)", () => {
    const md = renderReport(
      baseReport({
        accuracy: [
          {
            mode: "hybrid+rerank",
            scored: 25,
            errors: 0,
            results: [{ metric: "top1", digits: 10, hits: 12, total: 25, accuracy: 0.48 }],
          },
        ],
        accuracyDigits: [10],
        rag: [{ mode: "hybrid+rerank", scored: 10, scores: [{ name: "Faithfulness", score: 0.85 }] }],
      }),
    );
    // The advanced numbers must appear (regression: they were dropped when dense was absent),
    // with the missing baseline column rendered as "—".
    expect(md).toMatch(/top-1 exact \(≥10-digit\) \| — \| 48\.0% \| —/);
    expect(md).toMatch(/Faithfulness \| — \| 85\.0% \| —/);
    expect(md).not.toMatch(/End-to-end suite not run/);
    expect(md).not.toMatch(/RAG-metrics suite not run/);
  });

  it("flags a degraded advanced arm when a meaningful fraction of reranks fell back", () => {
    const data = baseReport();
    data.recall[1].rerankFallbacks = 180; // advanced arm scored 200 → 90% fell back
    const md = renderReport(data);
    expect(md).toMatch(/⚠️ \*\*Advanced arm degraded/);
    expect(md).toMatch(/did not run on 180\/200 rows/);
    expect(md).toMatch(/\*\*fused-hybrid, not reranked\*\*/);
    // The caveat must precede the headline lift claim it qualifies.
    expect(md.indexOf("Advanced arm degraded")).toBeLessThan(md.indexOf("**Headline:**"));
  });

  it("stays quiet when the reranker ran cleanly (no fallbacks)", () => {
    const data = baseReport();
    data.recall[1].rerankFallbacks = 0;
    expect(renderReport(data)).not.toMatch(/Advanced arm degraded/);
  });

  it("stays quiet for a negligible fallback fraction below the warn threshold", () => {
    const data = baseReport();
    data.recall[1].rerankFallbacks = 5; // 5/200 = 2.5% < 10% threshold
    expect(renderReport(data)).not.toMatch(/Advanced arm degraded/);
  });

  it("does not warn when rerank health was never recorded (field absent)", () => {
    // baseReport()'s recall suites carry no rerankFallbacks — the common path
    // (e.g. dense-only, or a run predating the counter) must not falsely warn.
    expect(renderReport(baseReport())).not.toMatch(/Advanced arm degraded/);
  });

  it("surfaces asymmetric per-mode scored counts instead of a single nominal size", () => {
    const md = renderReport(
      baseReport({
        accuracy: [
          { mode: "dense", scored: 25, errors: 0, results: [{ metric: "top1", digits: 10, hits: 10, total: 25, accuracy: 0.4 }] },
          { mode: "hybrid+rerank", scored: 22, errors: 3, results: [{ metric: "top1", digits: 10, hits: 11, total: 22, accuracy: 0.5 }] },
        ],
        accuracyDigits: [10],
      }),
    );
    expect(md).toMatch(/dense: 25, hybrid\+rerank: 22/);
  });
});

describe("headlineRecallLift", () => {
  it("returns the largest per-cell recall delta", () => {
    const lift = headlineRecallLift(baseReport());
    expect(lift).not.toBeNull();
    expect(lift!.delta).toBeCloseTo(0.15);
  });

  it("returns null when only one mode ran (no baseline-vs-advanced pair)", () => {
    const data = baseReport();
    expect(headlineRecallLift({ ...data, recall: [data.recall[0]] })).toBeNull();
  });
});
