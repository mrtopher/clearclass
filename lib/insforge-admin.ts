/**
 * Shared InsForge admin-access helpers for the offline scripts and the SDK-free
 * retrieval transport.
 *
 * The @insforge/sdk bundle `require()`s `@insforge/shared-schemas`, which ships
 * only an ESM `export` condition — it loads under Next's bundler but NOT under a
 * plain tsx/Node offline script. So the corpus load (`scripts/embed-load.ts`),
 * the dense retriever (`lib/retrieval/dense.ts`), and the recall harness all talk
 * to InsForge's PostgREST proxy directly with `fetch`. The admin API key
 * authenticates as `Bearer` and bypasses RLS — correct for out-of-band access to
 * the shared reference corpus, never for a per-user runtime request.
 *
 * This module owns the one thing they all need identically: resolving the admin
 * base URL + key, the auth header, and a timeout-bounded fetch. Table- or
 * RPC-specific request shaping stays with each caller.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface AdminConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Resolve the admin base URL + API key, preferring env, then the linked
 * `.insforge/project.json`. Throws loudly when neither is available so a
 * misconfigured run fails at startup rather than on the first request.
 */
export function resolveAdminConfig(): AdminConfig {
  const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_BASE_URL;
  let apiKey = process.env.INSFORGE_API_KEY;

  if (!apiKey) {
    // Local-dev convenience: the linked project's admin key lives here. Never
    // committed (.insforge/ is gitignored); env takes precedence in CI/deploy.
    try {
      const linked = JSON.parse(
        readFileSync(resolve(process.cwd(), ".insforge/project.json"), "utf8"),
      ) as { api_key?: string };
      apiKey = linked.api_key;
    } catch {
      // fall through to the loud error below
    }
  }

  if (!baseUrl || !apiKey) {
    throw new Error(
      "[insforge-admin] Insforge admin config missing. Set NEXT_PUBLIC_INSFORGE_BASE_URL and " +
        "INSFORGE_API_KEY (server-only), or run `npx @insforge/cli link` so " +
        ".insforge/project.json is present. See .env.example.",
    );
  }
  return { baseUrl, apiKey };
}

export function authHeaders(cfg: AdminConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Per-request timeout — Node's global fetch has none, so a hung socket would
 * otherwise stall a whole load/retrieval run (and defeat `withRetry`) forever.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

export function adminFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}
