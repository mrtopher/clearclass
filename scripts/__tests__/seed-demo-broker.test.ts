import { describe, expect, it } from "vitest";

import {
  findUserIdInList,
  isAlreadyLinked,
  resolveDemoConfig,
  DEMO_DEFAULTS,
} from "@/scripts/seed-demo-broker";

/**
 * The seed's pure classification/parse logic — the parts a re-run or a
 * shape-shift could get subtly wrong — exercised without a network, mirroring
 * `verify-rls`'s pure-verdict tests.
 */

describe("resolveDemoConfig", () => {
  it("falls back to the shared defaults when env is empty", () => {
    expect(resolveDemoConfig({})).toEqual(DEMO_DEFAULTS);
  });

  it("honors env overrides and trims email/importer", () => {
    const cfg = resolveDemoConfig({
      DEMO_EMAIL: "  me@x.co ",
      DEMO_PASSWORD: " keep spaces ",
      DEMO_IMPORTER: "  Acme  ",
    });
    expect(cfg).toEqual({
      email: "me@x.co",
      password: " keep spaces ", // password intentionally not trimmed
      importerName: "Acme",
    });
  });

  it("treats a blank/whitespace override as absent", () => {
    expect(resolveDemoConfig({ DEMO_EMAIL: "   " }).email).toBe(DEMO_DEFAULTS.email);
  });
});

describe("isAlreadyLinked (idempotent membership)", () => {
  it("treats 409 as already-linked", () => {
    expect(isAlreadyLinked(409, "")).toBe(true);
  });

  it("treats a unique-violation body as already-linked at any status", () => {
    expect(isAlreadyLinked(400, "duplicate key value violates unique constraint")).toBe(true);
    expect(isAlreadyLinked(500, "ERROR: 23505")).toBe(true);
  });

  it("does not treat an unrelated error as already-linked", () => {
    expect(isAlreadyLinked(500, "permission denied for table importer_members")).toBe(false);
    expect(isAlreadyLinked(400, "invalid input syntax for type uuid")).toBe(false);
  });
});

describe("findUserIdInList", () => {
  const body = {
    data: [
      { id: "u1", email: "Broker@ClearClass.Demo" },
      { id: "u2", email: "other@x.co" },
    ],
  };

  it("finds the id by case-insensitive exact email", () => {
    expect(findUserIdInList(body, "broker@clearclass.demo")).toBe("u1");
  });

  it("returns null when no exact match", () => {
    expect(findUserIdInList(body, "nobody@x.co")).toBeNull();
  });

  it("returns null for a malformed/empty response", () => {
    expect(findUserIdInList({}, "x@y.co")).toBeNull();
    expect(findUserIdInList({ data: "nope" }, "x@y.co")).toBeNull();
    expect(findUserIdInList(null, "x@y.co")).toBeNull();
  });
});
