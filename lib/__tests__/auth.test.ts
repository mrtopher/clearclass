import { describe, expect, it } from "vitest";

import { resolveEffectiveImporter } from "@/lib/auth";

/**
 * `resolveEffectiveImporter` is the KTD10 security decision distilled to a pure
 * function: given the server-VERIFIED membership set and the client's UNTRUSTED
 * requested importer, which importer (if any) may this request act for. The
 * isolation guarantee lives or dies here, so it is proven exhaustively — no
 * backend, no token.
 */
describe("resolveEffectiveImporter", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const C = "33333333-3333-3333-3333-333333333333";

  it("honors a requested importer the broker is a member of (happy path)", () => {
    expect(resolveEffectiveImporter([A, B], A)).toEqual({
      ok: true,
      importerId: A,
    });
  });

  it("defaults to the broker's primary importer when none is requested", () => {
    expect(resolveEffectiveImporter([A, B])).toEqual({ ok: true, importerId: A });
    expect(resolveEffectiveImporter([A, B], null)).toEqual({
      ok: true,
      importerId: A,
    });
    expect(resolveEffectiveImporter([A, B], "")).toEqual({
      ok: true,
      importerId: A,
    });
  });

  it("REJECTS a requested importer the broker is not a member of — never falls back", () => {
    // The cross-importer escalation: a client asking for importer C must be
    // refused, NOT silently served their own default importer.
    expect(resolveEffectiveImporter([A, B], C)).toEqual({
      ok: false,
      reason: "forbidden-importer",
    });
  });

  it("lets a two-importer broker switch between exactly those two (edge case)", () => {
    expect(resolveEffectiveImporter([A, B], A)).toEqual({ ok: true, importerId: A });
    expect(resolveEffectiveImporter([A, B], B)).toEqual({ ok: true, importerId: B });
    // ...but not a third they don't belong to.
    expect(resolveEffectiveImporter([A, B], C)).toEqual({
      ok: false,
      reason: "forbidden-importer",
    });
  });

  it("refuses any importer when the broker has no memberships", () => {
    expect(resolveEffectiveImporter([], A)).toEqual({
      ok: false,
      reason: "no-membership",
    });
    expect(resolveEffectiveImporter([])).toEqual({
      ok: false,
      reason: "no-membership",
    });
  });
});
