import { describe, expect, it } from "vitest";

import {
  candidateSchema,
  citationSchema,
  classificationSchema,
  type Candidate,
} from "@/lib/schema";

/**
 * The structured contract U6 emits and U8 renders. These assert the *hard*
 * parts: exactly three candidates (R4), a bounded confidence (R5), and the
 * nullable-not-optional citation fields the OpenAI-compatible gateway requires.
 */

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    hts_code: "6109.10.0012",
    reasoning: "GRI 1: the heading for cotton t-shirts covers this by its terms.",
    citations: [
      {
        source: "corpus",
        chunk_id: 42,
        hts_code: "6109.10.0012",
        ruling_number: null,
        gri_rule: null,
        url: null,
        title: null,
      },
    ],
    confidence: 0.8,
    ...overrides,
  };
}

function classification(candidates: Candidate[]) {
  return {
    candidates,
    recommendation: { hts_code: candidates[0]?.hts_code ?? "x", why: "best fit" },
    why_not: [
      { hts_code: "9999.99.9999", why: "wrong material" },
      { hts_code: "8888.88.8888", why: "wrong use" },
    ],
  };
}

describe("citationSchema", () => {
  it("accepts a corpus citation carrying a real chunk_id", () => {
    const parsed = citationSchema.parse({
      source: "corpus",
      chunk_id: 7,
      hts_code: "0101.21.0010",
      ruling_number: null,
      gri_rule: null,
      url: null,
      title: null,
    });
    expect(parsed.chunk_id).toBe(7);
  });

  it("accepts a web citation carrying a url and a null chunk_id", () => {
    const parsed = citationSchema.parse({
      source: "web",
      chunk_id: null,
      hts_code: null,
      ruling_number: null,
      gri_rule: null,
      url: "https://ustr.gov/section-301",
      title: "2026 Section 301 update",
    });
    expect(parsed.source).toBe("web");
    expect(parsed.url).toContain("ustr.gov");
  });

  it("rejects an unknown source", () => {
    expect(() =>
      citationSchema.parse({
        source: "guess",
        chunk_id: null,
        hts_code: null,
        ruling_number: null,
        gri_rule: null,
        url: null,
        title: null,
      }),
    ).toThrow();
  });
});

describe("candidateSchema", () => {
  it("rejects a confidence outside [0, 1]", () => {
    expect(() => candidateSchema.parse(candidate({ confidence: 1.5 }))).toThrow();
  });

  it("rejects an empty hts_code", () => {
    expect(() => candidateSchema.parse(candidate({ hts_code: "" }))).toThrow();
  });
});

describe("classificationSchema", () => {
  it("accepts exactly three candidates", () => {
    const parsed = classificationSchema.parse(
      classification([candidate(), candidate(), candidate()]),
    );
    expect(parsed.candidates).toHaveLength(3);
  });

  it("rejects fewer than three candidates (the exactly-3 contract)", () => {
    expect(() =>
      classificationSchema.parse(classification([candidate(), candidate()])),
    ).toThrow();
  });

  it("rejects more than three candidates", () => {
    expect(() =>
      classificationSchema.parse(
        classification([candidate(), candidate(), candidate(), candidate()]),
      ),
    ).toThrow();
  });
});
