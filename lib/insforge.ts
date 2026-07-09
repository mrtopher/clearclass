import { createClient } from "@insforge/sdk";

/**
 * Insforge is the single backend (KTD2): Postgres + pgvector for the corpus
 * and per-importer memory, plus auth and the model gateway.
 *
 * `baseUrl` (and `anonKey`, if ever set) are the ONLY Insforge credentials
 * permitted in client code (KTD11), exposed as NEXT_PUBLIC_ vars. `anonKey` is
 * OPTIONAL and ClearClass does not set one — it exposes no anon-readable data, so
 * client calls authenticate with the logged-in user's JWT and the SDK treats the
 * absent `anonKey` as undefined. Privileged, tenant-scoped access is derived
 * server-side from a verified JWT (KTD10), added in U11 — never a service key in
 * the client bundle.
 */
const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_BASE_URL;
const anonKey = process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY;

if (!baseUrl) {
  // Surface misconfiguration loudly rather than failing silently at call time.
  console.warn(
    "[insforge] NEXT_PUBLIC_INSFORGE_BASE_URL is not set — see .env.example",
  );
}

export const insforge = createClient({
  baseUrl: baseUrl ?? "",
  anonKey: anonKey ?? undefined,
});
