import { describe, expect, it } from "vitest";

import {
  chatErrorMessage,
  describeSources,
  formatConfidence,
  toCandidateViews,
} from "@/lib/classification-view";
import type { Candidate, ClassificationResult } from "@/lib/schema";

/**
 * U8's presentation logic is where the flat server contract becomes something a
 * broker reads: candidates zipped to their recommendation/why-not defense, the
 * source marker (AE1/AE2), and HTTP failures turned into guidance. These are the
 * branchy parts worth proving before any React renders them.
 */

function candidate(hts_code: string, confidence = 0.5): Candidate {
  return {
    hts_code,
    reasoning: `reasoning for ${hts_code}`,
    citations: [
      {
        source: "corpus",
        chunk_id: 1,
        hts_code,
        ruling_number: null,
        gri_rule: "GRI 1",
        url: null,
        title: null,
      },
    ],
    confidence,
  };
}

function result(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    candidates: [candidate("6109100010", 0.9), candidate("6110200020", 0.6), candidate("6205200050", 0.3)],
    recommendation: { hts_code: "6109100010", why: "best fit under GRI 1" },
    why_not: [
      { hts_code: "6110200020", why: "wrong garment class" },
      { hts_code: "6205200050", why: "wrong material" },
    ],
    sources_used: { corpus: true, web: false, corpus_chunk_ids: [1], web_urls: [] },
    ...overrides,
  };
}

describe("toCandidateViews", () => {
  it("preserves ranked order and 1-based rank", () => {
    const views = toCandidateViews(result());
    expect(views.map((v) => v.rank)).toEqual([1, 2, 3]);
    expect(views.map((v) => v.hts_code)).toEqual([
      "6109100010",
      "6110200020",
      "6205200050",
    ]);
  });

  it("marks exactly the recommended candidate and gives it the recommendation rationale", () => {
    const views = toCandidateViews(result());
    const recommended = views.filter((v) => v.isRecommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0].hts_code).toBe("6109100010");
    expect(recommended[0].rationale).toBe("best fit under GRI 1");
  });

  it("attaches each non-recommended candidate's why-not rationale by hts_code", () => {
    const views = toCandidateViews(result());
    const others = views.filter((v) => !v.isRecommended);
    expect(others.map((v) => v.rationale)).toEqual([
      "wrong garment class",
      "wrong material",
    ]);
  });

  it("associates by code even when candidate order differs from why_not order", () => {
    const r = result({
      why_not: [
        { hts_code: "6205200050", why: "material mismatch" },
        { hts_code: "6110200020", why: "class mismatch" },
      ],
    });
    const byCode = new Map(toCandidateViews(r).map((v) => [v.hts_code, v.rationale]));
    expect(byCode.get("6110200020")).toBe("class mismatch");
    expect(byCode.get("6205200050")).toBe("material mismatch");
  });

  it("degrades to a null rationale rather than throwing when an entry references a code not among the candidates", () => {
    const r = result({
      recommendation: { hts_code: "9999999999", why: "orphan recommendation" },
    });
    const views = toCandidateViews(r);
    // No candidate matches the recommendation code, so none is recommended and
    // the two real why_not codes still resolve; the third (the ex-recommended)
    // has no rationale.
    expect(views.some((v) => v.isRecommended)).toBe(false);
    expect(views.find((v) => v.hts_code === "6109100010")?.rationale).toBeNull();
  });
});

describe("formatConfidence", () => {
  it("renders a whole-percent label", () => {
    expect(formatConfidence(0.872)).toBe("87%");
    expect(formatConfidence(0)).toBe("0%");
    expect(formatConfidence(1)).toBe("100%");
  });

  it("clamps out-of-range values", () => {
    expect(formatConfidence(-0.2)).toBe("0%");
    expect(formatConfidence(1.5)).toBe("100%");
  });
});

describe("describeSources", () => {
  it("labels corpus-only (AE1)", () => {
    expect(
      describeSources({ corpus: true, web: false, corpus_chunk_ids: [1], web_urls: [] }),
    ).toBe("Grounded corpus only");
  });

  it("labels corpus + web (AE2)", () => {
    expect(
      describeSources({
        corpus: true,
        web: true,
        corpus_chunk_ids: [1],
        web_urls: ["https://x"],
      }),
    ).toBe("Grounded corpus + live web search");
  });

  it("labels the empty case without crashing", () => {
    expect(
      describeSources({ corpus: false, web: false, corpus_chunk_ids: [], web_urls: [] }),
    ).toBe("No sources recorded");
  });
});

describe("chatErrorMessage", () => {
  it("surfaces the caller-fault detail on 400", () => {
    expect(chatErrorMessage(400, { error: "invalid_request", detail: "empty message" })).toContain(
      "empty message",
    );
  });

  it("prompts re-auth on 401 and blocks importer on 403", () => {
    expect(chatErrorMessage(401)).toMatch(/sign in/i);
    expect(chatErrorMessage(403)).toMatch(/importer/i);
  });

  it("relays the rate-limit message on 429 and never leaks internals on 502", () => {
    expect(chatErrorMessage(429, { error: "rate_limited", message: "slow down" })).toBe(
      "slow down",
    );
    const degraded = chatErrorMessage(502, { error: "classification_failed" });
    expect(degraded).toMatch(/temporarily unavailable/i);
    expect(degraded).not.toContain("classification_failed");
  });

  it("has a generic fallback for unexpected statuses", () => {
    expect(chatErrorMessage(418)).toBe("Something went wrong. Please try again.");
  });
});
