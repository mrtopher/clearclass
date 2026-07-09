import { describe, expect, it } from "vitest";

import { createRateLimiter } from "@/lib/rate-limit";

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
});
