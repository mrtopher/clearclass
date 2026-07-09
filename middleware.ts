/**
 * U11 — edge middleware: session refresh + `/api/chat` rate limiting.
 *
 * Two jobs, in cost-ascending order:
 *  1. Rate-limit the billable path FIRST, before any network work, so a flood is
 *     rejected cheaply and never reaches the refresh endpoint or the agent loop.
 *  2. Keep the short-lived access token fresh via the InsForge SSR helper, which
 *     rotates the access-token cookie using the server-owned httpOnly refresh
 *     cookie. This runs the SDK's `ssr/middleware` subpath, which bundles only the
 *     session helpers (no full client) so it stays edge-safe.
 *
 * The route handler (`app/api/chat/route.ts`) is the authoritative auth gate —
 * this middleware does NOT authenticate. Its rate limit keys on the session token
 * when present (per-broker) and falls back to client IP (per-IP) otherwise, so an
 * unauthenticated flood is still bounded.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  updateSession,
  type CookieStore,
} from "@insforge/sdk/ssr/middleware";

import { createRateLimiter } from "@/lib/rate-limit";

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 30);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);

const checkRateLimit = createRateLimiter({
  max: RATE_LIMIT_MAX,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

/**
 * Rate-limit key: the session (access-token cookie) when authenticated, else the
 * client IP. A token prefix is enough to distinguish sessions without logging the
 * whole credential.
 */
function clientKey(request: NextRequest): string {
  const token = request.cookies.get("insforge_access_token")?.value;
  if (token) return `session:${token.slice(0, 24)}`;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  return `ip:${ip}`;
}

/**
 * Rotate the access-token cookie. Next's `RequestCookies`/`ResponseCookies` and
 * the SDK's structural `CookieStore` differ only in the shape of the (optional)
 * `set` overload, so this is the SDK's documented middleware usage with the
 * overload variance bridged at the one call boundary.
 */
function refreshSession(request: NextRequest, response: NextResponse) {
  return updateSession({
    requestCookies: request.cookies as unknown as CookieStore,
    responseCookies: response.cookies as unknown as CookieStore,
    baseUrl: process.env.NEXT_PUBLIC_INSFORGE_BASE_URL ?? "",
    anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY,
  });
}

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/chat")) {
    const { allowed, remaining, resetAt } = checkRateLimit(clientKey(request));
    if (!allowed) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
      return NextResponse.json(
        { error: "rate_limited", message: "Too many requests. Please slow down." },
        { status: 429, headers: { "Retry-After": String(retryAfter) } },
      );
    }
    const response = NextResponse.next({ request });
    response.headers.set("X-RateLimit-Remaining", String(remaining));
    await refreshSession(request, response);
    return response;
  }

  const response = NextResponse.next({ request });
  await refreshSession(request, response);
  return response;
}

export const config = {
  // Run on app pages (session refresh) and the billable API path (rate limit),
  // skipping static assets and Next internals.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
