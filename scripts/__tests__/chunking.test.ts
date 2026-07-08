import { describe, expect, it } from "vitest";
import { chunkHtsRows, type HtsRow } from "@/lib/chunking";

/**
 * Fixtures are verbatim slices of the real USITC export
 * (`hts.usitc.gov/reststop/exportList?...&styles=false`), captured during U2
 * so the tests exercise the actual data shape — indent-driven hierarchy,
 * `superior:"true"` grouping rows with empty `htsno`, and duty rates that live
 * on an 8-digit rate-line ancestor while the statistical leaf's `general` is
 * empty. This is the plan's single biggest accuracy risk (KTD3), so the tests
 * pin the exact ancestry + inherited metadata for known codes.
 */

// Heading 6109 — the plan's happy-path example (cotton T-shirts).
const HEADING_6109: HtsRow[] = [
  { htsno: "6109", indent: "0", superior: null, units: [], general: "", description: "T-shirts, singlets, tank tops and similar garments, knitted or crocheted:" },
  { htsno: "6109.10.00", indent: "1", superior: null, units: [], general: "16.5%", description: "Of cotton" },
  { htsno: "", indent: "2", superior: "true", units: [], general: "", description: "Men's or boys':" },
  { htsno: "6109.10.00.04", indent: "3", superior: null, units: ["doz.", "kg"], general: "", description: "T-shirts, all white, short hemmed sleeves, hemmed bottom, crew or round neckline, or V-neck with a mitered seam at the center of the V, made in one or more colors (338)" },
  { htsno: "6109.10.00.11", indent: "3", superior: null, units: ["doz.", "kg"], general: "", description: "Thermal undershirts (352)" },
  { htsno: "", indent: "3", superior: "true", units: [], general: "", description: "Other T-shirts:" },
  { htsno: "6109.10.00.12", indent: "4", superior: null, units: ["doz.", "kg"], general: "", description: "Men's (338)" },
  { htsno: "6109.10.00.14", indent: "4", superior: null, units: ["doz.", "kg"], general: "", description: "Boys' (338)" },
];

// Heading 0101 — mixes a superior grouping row, deep statistical leaves whose
// duty is inherited from an 8-digit ancestor, and a 10-digit leaf that carries
// its own duty directly at indent 1.
const HEADING_0101: HtsRow[] = [
  { htsno: "0101", indent: "0", superior: null, units: [], general: "", description: "Live horses, asses, mules and hinnies:" },
  { htsno: "", indent: "1", superior: "true", units: [], general: "", description: "Horses:" },
  { htsno: "0101.21.00", indent: "2", superior: null, units: [], general: "Free", description: "Purebred breeding animals" },
  { htsno: "0101.21.00.10", indent: "3", superior: null, units: ["No."], general: "", description: "Males" },
  { htsno: "0101.21.00.20", indent: "3", superior: null, units: ["No."], general: "", description: "Females" },
  { htsno: "0101.30.00.00", indent: "1", superior: null, units: ["No."], general: "6.8%", description: "Asses" },
];

describe("chunkHtsRows — hierarchy-preserving HTS chunking (KTD3)", () => {
  it("happy path: a known leaf carries its full ancestor path in text and correct metadata", () => {
    const chunks = chunkHtsRows(HEADING_6109);
    const tshirt = chunks.find((c) => c.metadata.hts_code === "6109.10.00.12");

    expect(tshirt, "expected a chunk for 6109.10.00.12").toBeDefined();
    // Text materializes every ancestor description, root -> leaf, including the
    // two superior grouping rows.
    expect(tshirt!.content).toContain("T-shirts, singlets, tank tops");
    expect(tshirt!.content).toContain("Of cotton");
    expect(tshirt!.content).toContain("Men's or boys':");
    expect(tshirt!.content).toContain("Other T-shirts:");
    expect(tshirt!.content).toContain("Men's (338)");
    // Ancestors appear before the leaf's own description (path order preserved).
    expect(tshirt!.content.indexOf("Of cotton")).toBeLessThan(
      tshirt!.content.indexOf("Men's (338)"),
    );

    expect(tshirt!.metadata.chapter).toBe("61");
    expect(tshirt!.metadata.heading).toBe("6109");
    expect(tshirt!.metadata.subheading).toBe("6109.10");
    // Duty rate is inherited from the 8-digit rate line (6109.10.00 = 16.5%),
    // NOT read from the leaf (whose own `general` is empty).
    expect(tshirt!.metadata.general_duty).toBe("16.5%");
  });

  it("preserves multiple units of quantity on a leaf", () => {
    const chunks = chunkHtsRows(HEADING_6109);
    const tshirt = chunks.find((c) => c.metadata.hts_code === "6109.10.00.12");
    expect(tshirt!.metadata.units).toEqual(["doz.", "kg"]);
  });

  it("tags every chunk with a stable corpus type for the documents table", () => {
    const chunks = chunkHtsRows(HEADING_6109);
    expect(chunks.every((c) => c.type === "hts")).toBe(true);
  });

  it("does not emit a chunk for superior/grouping rows (no empty-code duplicates)", () => {
    const chunks = chunkHtsRows(HEADING_6109);
    // Only true leaf lines become chunks; the header, the 8-digit rate line,
    // and the two superior rows must not.
    expect(chunks.every((c) => c.metadata.hts_code.length > 0)).toBe(true);
    expect(chunks.some((c) => c.metadata.hts_code === "6109")).toBe(false);
    expect(chunks.some((c) => c.metadata.hts_code === "6109.10.00")).toBe(false);
    // The 6109 fixture has exactly 4 leaves: .04, .11, .12, .14.
    expect(chunks.map((c) => c.metadata.hts_code).sort()).toEqual([
      "6109.10.00.04",
      "6109.10.00.11",
      "6109.10.00.12",
      "6109.10.00.14",
    ]);
  });

  it("inherits duty across a superior row and also honors a leaf's own direct rate", () => {
    const chunks = chunkHtsRows(HEADING_0101);

    const males = chunks.find((c) => c.metadata.hts_code === "0101.21.00.10");
    expect(males, "expected a chunk for 0101.21.00.10").toBeDefined();
    // Path crosses the "Horses:" superior row and the 8-digit "Purebred..." line.
    expect(males!.content).toContain("Horses:");
    expect(males!.content).toContain("Purebred breeding animals");
    expect(males!.content).toContain("Males");
    expect(males!.metadata.general_duty).toBe("Free");
    expect(males!.metadata.subheading).toBe("0101.21");

    // A 10-digit leaf sitting directly at indent 1 carries its own duty rate.
    const asses = chunks.find((c) => c.metadata.hts_code === "0101.30.00.00");
    expect(asses!.metadata.general_duty).toBe("6.8%");
    expect(asses!.metadata.units).toEqual(["No."]);
  });

  it("skips chapter-internal section labels (empty-code rows) without emitting or throwing", () => {
    // Real chapter-28 shape: a `superior` roman-numeral label sits at indent 1,
    // then the actual heading resets to indent 0. The label is a standalone
    // grouping row that classifies nothing — it must be skipped, not throw and
    // not become a code-less chunk.
    const chapter28Start: HtsRow[] = [
      { htsno: "", indent: "1", superior: "true", units: [], general: "", description: "I. CHEMICAL ELEMENTS" },
      { htsno: "2801", indent: "0", superior: null, units: [], general: "", description: "Fluorine, chlorine, bromine and iodine:" },
      { htsno: "2801.10.00.00", indent: "1", superior: null, units: ["kg"], general: "Free", description: "Chlorine" },
    ];
    const chunks = chunkHtsRows(chapter28Start);
    expect(chunks.map((c) => c.metadata.hts_code)).toEqual(["2801.10.00.00"]);
    // The label is a sibling of the heading (higher indent, but reset below it),
    // so it is not an ancestor of the leaf.
    expect(chunks[0].content).not.toContain("CHEMICAL ELEMENTS");
    expect(chunks[0].content).toContain("Fluorine, chlorine");
  });

  it("fails loudly on a non-array input rather than silently emitting nothing", () => {
    // @ts-expect-error — deliberately wrong type to prove the guard fires.
    expect(() => chunkHtsRows(null)).toThrow();
  });

  it("fails loudly on a non-numeric indent (corrupt tree structure)", () => {
    const corrupt: HtsRow[] = [
      { htsno: "6109", indent: "0", superior: null, units: [], general: "", description: "Heading" },
      { htsno: "6109.10.00.12", indent: "x", superior: null, units: ["doz."], general: "16.5%", description: "Men's" },
    ];
    expect(() => chunkHtsRows(corrupt)).toThrow(/indent/);
  });

  it("fails loudly on a negative indent", () => {
    const negative: HtsRow[] = [
      { htsno: "6109.10.00.12", indent: "-1", superior: null, units: ["doz."], general: "16.5%", description: "Men's" },
    ];
    expect(() => chunkHtsRows(negative)).toThrow(/indent/);
  });

  it("falls back to the heading when a leaf code has fewer than 6 digits", () => {
    // Defensive: a short/terminal code shouldn't crash the subheading derivation.
    const short: HtsRow[] = [
      { htsno: "9999", indent: "0", superior: null, units: [], general: "Free", description: "Terminal heading with no subdivision" },
    ];
    const [chunk] = chunkHtsRows(short);
    expect(chunk.metadata.chapter).toBe("99");
    expect(chunk.metadata.heading).toBe("9999");
    expect(chunk.metadata.subheading).toBe("9999");
  });

  it("yields an empty general_duty when neither the leaf nor any ancestor carries a rate", () => {
    // Real shape for chapter 98/99 special provisions where the duty is a
    // cross-reference, not a column-1 rate.
    const noRate: HtsRow[] = [
      { htsno: "9903", indent: "0", superior: null, units: [], general: "", description: "Special provisions" },
      { htsno: "9903.88.03", indent: "1", superior: null, units: [], general: "", description: "Articles the product of China" },
    ];
    const leaf = chunkHtsRows(noRate).find((c) => c.metadata.hts_code === "9903.88.03");
    expect(leaf!.metadata.general_duty).toBe("");
  });
});
