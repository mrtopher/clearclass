import { describe, expect, it } from "vitest";

import { interpretAnonRead } from "@/scripts/verify-rls";

/**
 * `interpretAnonRead` decides whether an unauthenticated (anon) read of a tenant
 * table was properly refused. The live run is I/O; this pins the classification
 * so the gate cannot silently start treating a leak or a missing table as a pass.
 */
describe("interpretAnonRead", () => {
  it("treats a 403/401 permission denial as isolated (the goal)", () => {
    expect(interpretAnonRead(403, "permission denied for table classifications").kind).toBe(
      "isolated",
    );
    expect(interpretAnonRead(401, "unauthorized").kind).toBe("isolated");
  });

  it("flags a 2xx response that returns rows as a LEAK", () => {
    expect(interpretAnonRead(200, JSON.stringify([{ id: 1 }])).kind).toBe("leak");
  });

  it("flags a missing relation as not-applied (migration not run)", () => {
    expect(interpretAnonRead(404, "").kind).toBe("not-applied");
    expect(
      interpretAnonRead(400, 'relation "public.classifications" does not exist').kind,
    ).toBe("not-applied");
  });

  it("does NOT treat a missing-column error as not-applied (probe bug, not a migration gap)", () => {
    // A composite-PK table (e.g. importer_members) has no `id`; a stray column
    // reference must not masquerade as an unapplied migration.
    expect(interpretAnonRead(400, 'column "id" does not exist').kind).not.toBe(
      "not-applied",
    );
  });

  it("marks a 2xx empty array as weak (RLS filtered, grant not revoked)", () => {
    expect(interpretAnonRead(200, "[]").kind).toBe("weak");
  });

  it("reports unexpected statuses as error", () => {
    expect(interpretAnonRead(500, "internal error").kind).toBe("error");
  });
});
