import { describe, expect, it } from "vitest";

import { buildGriChunks, GRI_RULE_COUNT } from "@/lib/gri";

/**
 * U3 GRI ingestion (covers the plan's GRI happy-path scenario): "GRI 1 through
 * the Additional US Rules each become one retrievable chunk tagged by rule."
 */
describe("buildGriChunks", () => {
  const chunks = buildGriChunks();

  it("emits one chunk per authored rule, all tagged type:'gri'", () => {
    expect(chunks).toHaveLength(GRI_RULE_COUNT);
    expect(chunks.every((c) => c.type === "gri")).toBe(true);
  });

  it("covers GRI 1 through 6 and the Additional U.S. Rules", () => {
    const rules = new Set(chunks.map((c) => c.metadata.rule));
    // The core six (with lettered sub-parts) ...
    for (const r of ["1", "2(a)", "2(b)", "3(a)", "3(b)", "3(c)", "4", "5(a)", "5(b)", "6"]) {
      expect(rules.has(r)).toBe(true);
    }
    // ... and the Additional U.S. Rules of Interpretation.
    expect([...rules].some((r) => r.startsWith("US "))).toBe(true);
  });

  it("gives each rule a unique, citable id and materializes the label into the text", () => {
    const ids = chunks.map((c) => c.metadata.rule);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate rule ids
    for (const c of chunks) {
      expect(c.content.startsWith(`${c.metadata.label}:`)).toBe(true);
      expect(c.content.length).toBeGreaterThan(c.metadata.label.length + 10);
    }
  });

  it("essential-character (3(b)) and last-in-order (3(c)) rules carry their key language", () => {
    const byRule = new Map(chunks.map((c) => [c.metadata.rule, c]));
    expect(byRule.get("3(b)")!.content).toMatch(/essential character/i);
    expect(byRule.get("3(c)")!.content).toMatch(/last in numerical order/i);
  });
});
