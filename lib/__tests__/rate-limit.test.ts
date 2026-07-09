import { describe, expect, it } from "vitest";

import { createRateLimiter, sessionKeyFromToken } from "@/lib/rate-limit";

/**
 * The limiter is the app-layer guard on the billable `/api/chat` path. Its window
 * behavior is proven with an injected clock so there are no timers, sleeps, or
 * flakiness — we advance time by hand.
 */
describe("createRateLimiter", () => {
  it("allows up to `max` requests then blocks within the window", () => {
    let now = 1_000;
    const check = createRateLimiter({ max: 3, windowMs: 60_000, now: () => now });

    expect(check("k").allowed).toBe(true); // 1
    expect(check("k").allowed).toBe(true); // 2
    const third = check("k"); // 3
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const blocked = check("k"); // 4 — over the limit
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("isolates counts per key (one broker's flood cannot exhaust another's budget)", () => {
    let now = 0;
    const check = createRateLimiter({ max: 1, windowMs: 60_000, now: () => now });

    expect(check("session:a").allowed).toBe(true);
    expect(check("session:a").allowed).toBe(false); // a is exhausted
    expect(check("ip:1.2.3.4").allowed).toBe(true); // b is untouched
  });

  it("resets the budget once the window elapses", () => {
    let now = 0;
    const check = createRateLimiter({ max: 1, windowMs: 1_000, now: () => now });

    expect(check("k").allowed).toBe(true);
    expect(check("k").allowed).toBe(false);

    now = 1_000; // window boundary reached
    const afterReset = check("k");
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(0);
  });

  it("refuses every request when max <= 0 (fully-closed config)", () => {
    let now = 0;
    const check = createRateLimiter({ max: 0, windowMs: 1_000, now: () => now });
    // Regression: the fresh-window branch used to leak one request per key.
    expect(check("k").allowed).toBe(false);
    expect(check("k").allowed).toBe(false);
  });
});

describe("sessionKeyFromToken", () => {
  // Two HS256 JWTs for different users share the header segment but differ in
  // payload + signature. Keying must NOT collapse them into one bucket.
  const HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const tokenA = `${HEADER}.eyJzdWIiOiJhbGljZSJ9.SIGNATURE_ALICE_abcdefghijklmnop`;
  const tokenB = `${HEADER}.eyJzdWIiOiJib2JfXyJ9.SIGNATURE_BOB_zyxwvutsrqponml`;

  it("returns null with no token (caller falls back to IP)", () => {
    expect(sessionKeyFromToken(undefined)).toBeNull();
    expect(sessionKeyFromToken("")).toBeNull();
  });

  it("distinguishes two users whose JWTs share the header segment", () => {
    const keyA = sessionKeyFromToken(tokenA);
    const keyB = sessionKeyFromToken(tokenB);
    expect(keyA).not.toBeNull();
    expect(keyA).not.toEqual(keyB); // the head-slice bug made these equal
  });

  it("falls back to the whole string for a non-JWT token", () => {
    expect(sessionKeyFromToken("opaque-token-value")).toBe("session:opaque-token-value");
  });
});
