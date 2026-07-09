/**
 * U11 — a small fixed-window rate limiter, the app-layer guard against an
 * open `/api/chat` cost-drain (each request can fan out to LLM + Tavily + Cohere
 * calls). It is deliberately pure and clock-injectable so the window behavior is
 * unit-tested deterministically, with no timers or sleeps.
 *
 * Scope honesty: the counter lives in the process (a Map), so it enforces per
 * *instance*. On a multi-instance / serverless deployment the effective limit is
 * `max × instances`, not `max`. That is intentional — this is defense in depth,
 * and the authoritative cross-instance backstop is the spend cap / budget alert
 * set on the LLM, Tavily, and Cohere keys (KTD11, see `.env.example`). A durable
 * shared store (e.g. an InsForge table or Redis) would be the upgrade if a hard
 * global limit is ever required.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining requests permitted in the current window. */
  remaining: number;
  /** Epoch ms at which the current window resets. */
  resetAt: number;
}

export interface RateLimiterOptions {
  /** Max requests allowed per key per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock; defaults to `Date.now`. Tests pass a controllable one. */
  now?: () => number;
}

/**
 * Derive a per-session rate-limit key from an access-token cookie, or null when
 * absent (caller falls back to an IP key). Keys on the JWT SIGNATURE segment: a
 * JWT is `header.payload.signature`, and its leading chars are the base64url
 * header (`{"alg":"HS256",...}`) — IDENTICAL across all users on one algorithm —
 * so a head slice would collapse every authenticated broker into a single bucket
 * (one broker's flood would 429 everyone). The signature is the entropy-bearing,
 * per-session part. Exported so this regression stays covered without a live edge
 * request. A non-JWT token falls back to the whole string.
 */
export function sessionKeyFromToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const parts = token.split(".");
  const signature = parts.length === 3 ? parts[2] : token;
  return `session:${signature.slice(0, 24)}`;
}

/** Soft cap after which expired windows are swept, bounding memory under churn. */
const PRUNE_THRESHOLD = 10_000;

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Build a limiter. Returns a `check(key)` function: call it once per request with
 * a stable key (per session or per IP). Each call both records the hit and
 * reports whether it was allowed.
 */
export function createRateLimiter({
  max,
  windowMs,
  now = () => Date.now(),
}: RateLimiterOptions) {
  const windows = new Map<string, Window>();

  function prune(at: number) {
    if (windows.size < PRUNE_THRESHOLD) return;
    for (const [key, window] of windows) {
      if (at >= window.resetAt) windows.delete(key);
    }
  }

  return function check(key: string): RateLimitResult {
    const at = now();
    // A non-positive max means "closed" — refuse every request. Guard here so the
    // fresh-window branch below can't leak one request per key when max <= 0.
    if (max <= 0) {
      return { allowed: false, remaining: 0, resetAt: at + windowMs };
    }
    prune(at);

    const window = windows.get(key);
    // No window yet, or the previous one has expired: start a fresh window.
    if (!window || at >= window.resetAt) {
      const resetAt = at + windowMs;
      windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: Math.max(0, max - 1), resetAt };
    }

    if (window.count >= max) {
      return { allowed: false, remaining: 0, resetAt: window.resetAt };
    }

    window.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, max - window.count),
      resetAt: window.resetAt,
    };
  };
}
