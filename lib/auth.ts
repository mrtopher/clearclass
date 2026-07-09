/**
 * U11 — server-side authentication + tenant scoping (KTD10).
 *
 * This module is the app-layer half of the isolation guarantee; the DB-layer
 * half is the RLS in `migrations/*_create-auth-tenant-tables.sql`. Both enforce
 * the SAME rule and must agree: the importer a broker acts for is derived from
 * the VERIFIED JWT (never the request body or the UI importer selector), and a
 * requested importer is honored only if the broker is a member of it.
 *
 * The security decision itself — `resolveEffectiveImporter` — is a pure function
 * with no I/O, so it is exhaustively unit-tested without a backend (mirroring the
 * dependency-injection seam in `lib/retrieval/dense.ts`). The I/O around it
 * (reading the verified principal + memberships) is a thin shell over the
 * InsForge SSR server client, which reads only the httpOnly-managed access-token
 * cookie and passes it as the per-request bearer — so `getCurrentUser()` and the
 * membership read both run as the authenticated principal and are RLS-scoped.
 *
 * SERVER-ONLY: imports `next/headers` and reads cookies; never import from a
 * client component.
 */
import { cookies } from "next/headers";
import { createServerClient } from "@insforge/sdk/ssr";

/** A verified, authenticated principal (a customs broker — actor A1). */
export interface Principal {
  /** `auth.users.id` from the verified token — the RLS `auth.uid()`. */
  userId: string;
  email?: string;
}

/** The fully-resolved, server-derived request scope handed to the agent loop. */
export interface TenantContext {
  principal: Principal;
  /** The effective importer key — server-derived, validated against membership. */
  importerId: string;
  /** Every importer this broker may act for (drives the UI selector in U8). */
  memberships: string[];
}

/**
 * The KTD10 decision, isolated as a pure function so it can be proven exhaustively.
 * `memberships` is the server-verified set of importers the broker belongs to;
 * `requested` is the untrusted importer key the client asked for (body / selector).
 *
 * - No memberships → the broker cannot act for any importer.
 * - Requested importer the broker is NOT a member of → REJECTED. Critically, this
 *   does not silently fall back to a default: honoring a non-member importer, or
 *   defaulting past an explicit-but-invalid request, is exactly the cross-importer
 *   escalation this guards against.
 * - Requested importer the broker IS a member of → that importer.
 * - No importer requested → the broker's primary (first) importer.
 */
export type TenantResolution =
  | { ok: true; importerId: string }
  | { ok: false; reason: "no-membership" | "forbidden-importer" };

export function resolveEffectiveImporter(
  memberships: string[],
  requested?: string | null,
): TenantResolution {
  if (memberships.length === 0) {
    return { ok: false, reason: "no-membership" };
  }
  if (requested != null && requested !== "") {
    return memberships.includes(requested)
      ? { ok: true, importerId: requested }
      : { ok: false, reason: "forbidden-importer" };
  }
  return { ok: true, importerId: memberships[0] };
}

/**
 * Build an SSR server client bound to the current request's cookies. Explicit
 * `baseUrl`/`anonKey` are passed so this honors the existing env contract
 * (`NEXT_PUBLIC_INSFORGE_BASE_URL`, set in `lib/insforge.ts`) rather than the
 * SSR helper's own `NEXT_PUBLIC_INSFORGE_URL` default.
 *
 * Exported so per-importer memory (U7) reads/writes `classifications` through
 * the SAME authenticated principal this module resolves — the request's JWT is
 * the bearer, so `classifications` RLS actually applies to those runtime calls
 * (unlike the admin-key corpus transport in `lib/retrieval/dense.ts`, which
 * bypasses RLS and must never touch a tenant-scoped table). SERVER-ONLY.
 */
export async function getServerClient() {
  const cookieStore = await cookies();
  return createServerClient({
    baseUrl: process.env.NEXT_PUBLIC_INSFORGE_BASE_URL ?? "",
    anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY,
    cookies: cookieStore,
  });
}

type ServerClient = Awaited<ReturnType<typeof getServerClient>>;

/** The verified principal, or null when the request carries no valid session. */
async function principalFrom(client: ServerClient): Promise<Principal | null> {
  try {
    const { data, error } = await client.auth.getCurrentUser();
    if (error || !data?.user) return null;
    return { userId: data.user.id, email: data.user.email ?? undefined };
  } catch {
    // A thrown verification (e.g. gateway/network failure) must fail CLOSED — an
    // unresolved principal is treated as unauthenticated (→ 401 at the gate),
    // never as an authenticated pass. Better a clean rejection than a 500.
    return null;
  }
}

/**
 * The importer ids this broker belongs to. The read runs as the authenticated
 * principal, so `importer_members` RLS (`user_id = auth.uid()`) already scopes it
 * to their own memberships — the explicit trust boundary, not a client filter.
 */
async function membershipsFrom(client: ServerClient): Promise<string[]> {
  const { data, error } = await client.database
    .from("importer_members")
    .select("importer_id");
  if (error || !data) return [];
  return (data as Array<{ importer_id: string }>).map((row) =>
    String(row.importer_id),
  );
}

/** Convenience: the verified principal for the current request, or null. */
export async function getPrincipal(): Promise<Principal | null> {
  return principalFrom(await getServerClient());
}

/**
 * Resolve the full request scope: verify the principal, read its memberships, and
 * derive the effective importer server-side. Returns a discriminated result so a
 * route maps `401` (no session) and `403` (no importer / non-member importer)
 * without leaking which case occurred beyond the reason string.
 */
export type ResolveTenantResult =
  | { ok: true; context: TenantContext }
  | { ok: false; status: 401 | 403; reason: string };

export async function resolveTenant(
  requestedImporterId?: string | null,
): Promise<ResolveTenantResult> {
  const client = await getServerClient();

  const principal = await principalFrom(client);
  if (!principal) {
    return { ok: false, status: 401, reason: "unauthenticated" };
  }

  const memberships = await membershipsFrom(client);
  const decision = resolveEffectiveImporter(memberships, requestedImporterId);
  if (!decision.ok) {
    return { ok: false, status: 403, reason: decision.reason };
  }

  return {
    ok: true,
    context: { principal, importerId: decision.importerId, memberships },
  };
}
