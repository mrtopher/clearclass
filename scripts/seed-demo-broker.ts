/**
 * Demo provisioning (U8 + U11 + KTD10) — create a broker who can classify end to
 * end on the deployed app, so the Loom demo isn't blocked on manual dashboard
 * clicks.
 *
 * Three things are required, and none happens on the self-signup path by design:
 *  1. A broker user whose email is CONFIRMED — the project requires email
 *     verification, so a plain signup lands unverified and cannot get a session.
 *     We create the user with `autoConfirm: true` via the admin API.
 *  2. An `importers` row (the tenant entity). Provisioned out-of-band by the
 *     admin key, never by a runtime request (the migration marks it admin-only).
 *  3. An `importer_members` row linking broker -> importer. This is the ONLY
 *     source of truth for which importer a broker may act for (KTD10); without it
 *     the app correctly shows the "no importer linked" state.
 *
 * Transport mirrors `scripts/embed-load.ts` / `scripts/verify-rls.ts`: the admin
 * Bearer key against the PostgREST proxy (`/api/database/records/<table>`) and the
 * auth API (`/api/auth/users`). The admin key bypasses RLS — correct for
 * out-of-band provisioning of the shared tenant rows, never a runtime path.
 *
 * IDEMPOTENT: safe to re-run. An existing broker/importer/membership is reused,
 * not duplicated. Run AFTER `npm run migrate`:
 *     npm run seed:demo
 *     DEMO_EMAIL=me@x.co DEMO_PASSWORD='…' DEMO_IMPORTER='Acme' npm run seed:demo
 *
 * Pure response-classification helpers are exported and unit-tested; the live run
 * wires the I/O (same split as the other scripts).
 */
import { pathToFileURL } from "node:url";

import {
  adminFetch,
  authHeaders,
  resolveAdminConfig,
  type AdminConfig,
} from "@/lib/insforge-admin";

export interface DemoConfig {
  email: string;
  password: string;
  importerName: string;
}

export const DEMO_DEFAULTS: DemoConfig = {
  email: "broker@clearclass.demo",
  password: "ClearClassDemo!2026",
  importerName: "Acme Imports LLC",
};

/** Resolve the demo identity from env, falling back to the shared defaults. */
export function resolveDemoConfig(
  env: Record<string, string | undefined> = process.env,
): DemoConfig {
  return {
    email: env.DEMO_EMAIL?.trim() || DEMO_DEFAULTS.email,
    password: env.DEMO_PASSWORD || DEMO_DEFAULTS.password,
    importerName: env.DEMO_IMPORTER?.trim() || DEMO_DEFAULTS.importerName,
  };
}

/**
 * A membership insert is idempotent: the composite PK `(importer_id, user_id)`
 * makes a re-run collide, which PostgREST surfaces as 409 / a unique-violation
 * (SQLSTATE 23505). That is "already linked" — success, not failure. Pure so the
 * classification is unit-testable without a network.
 */
export function isAlreadyLinked(status: number, bodyText: string): boolean {
  if (status === 409) return true;
  const body = bodyText.toLowerCase();
  return (
    body.includes("23505") ||
    body.includes("duplicate key") ||
    body.includes("already exists")
  );
}

/** The `{ data: [...] }` shape of `GET /api/auth/users`; find the exact-email id. */
export function findUserIdInList(body: unknown, email: string): string | null {
  const rows = (body as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return null;
  const match = rows.find(
    (u): u is { id: string; email: string } =>
      typeof u?.id === "string" &&
      typeof u?.email === "string" &&
      u.email.toLowerCase() === email.toLowerCase(),
  );
  return match?.id ?? null;
}

// ── I/O ──────────────────────────────────────────────────────────────────────

function authUrl(cfg: AdminConfig, path: string): string {
  return `${cfg.baseUrl}/api/auth/${path}`;
}
function recordsUrl(cfg: AdminConfig, table: string, query = ""): string {
  return `${cfg.baseUrl}/api/database/records/${table}${query}`;
}

/** Look up a user id by exact email via the admin list endpoint (`search=`). */
async function findBrokerId(cfg: AdminConfig, email: string): Promise<string | null> {
  const res = await adminFetch(
    authUrl(cfg, `users?search=${encodeURIComponent(email)}`),
    { method: "GET", headers: authHeaders(cfg) },
  );
  if (!res.ok) return null;
  return findUserIdInList(await res.json(), email);
}

/**
 * Create the broker as a CONFIRMED user, or reuse the existing one. Returns the
 * user id and whether the email is verified (a pre-existing unverified user with
 * this email can't be auto-confirmed here — we surface that rather than pretend).
 */
async function ensureBroker(
  cfg: AdminConfig,
  email: string,
  password: string,
): Promise<{ userId: string; created: boolean; emailVerified: boolean }> {
  const res = await adminFetch(authUrl(cfg, "users"), {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ email, password, autoConfirm: true }),
  });

  if (res.ok) {
    const body = (await res.json()) as {
      user?: { id?: string; emailVerified?: boolean };
    };
    if (body.user?.id) {
      return {
        userId: body.user.id,
        created: true,
        emailVerified: body.user.emailVerified === true,
      };
    }
  } else {
    // Non-OK is expected when the broker already exists — fall through to lookup.
    // Drain the body so the socket is freed even though we ignore the content.
    await res.text().catch(() => undefined);
  }

  const existingId = await findBrokerId(cfg, email);
  if (existingId) {
    // Assume a previously-seeded broker is confirmed; a first-run create sets it.
    return { userId: existingId, created: false, emailVerified: true };
  }
  throw new Error(
    `[seed-demo] could not create or find broker ${email} (create HTTP ${res.status}). ` +
      `If the email exists but is unverified, delete it first (DELETE /api/auth/users).`,
  );
}

/** Create the importer or reuse the one with this exact name. Returns its id. */
async function ensureImporter(cfg: AdminConfig, name: string): Promise<string> {
  const getRes = await adminFetch(
    recordsUrl(cfg, "importers", `?name=eq.${encodeURIComponent(name)}&select=id&limit=1`),
    { method: "GET", headers: authHeaders(cfg) },
  );
  if (getRes.ok) {
    const rows = (await getRes.json()) as Array<{ id?: string }>;
    if (Array.isArray(rows) && rows[0]?.id) return rows[0].id;
  } else {
    await getRes.text().catch(() => undefined);
  }

  const postRes = await adminFetch(recordsUrl(cfg, "importers"), {
    method: "POST",
    headers: { ...authHeaders(cfg), Prefer: "return=representation" },
    body: JSON.stringify([{ name }]),
  });
  if (!postRes.ok) {
    throw new Error(
      `[seed-demo] importer insert HTTP ${postRes.status}: ${(await postRes.text()).slice(0, 300)}`,
    );
  }
  const created = (await postRes.json()) as Array<{ id?: string }> | { id?: string };
  const id = Array.isArray(created) ? created[0]?.id : created?.id;
  if (!id) throw new Error("[seed-demo] importer insert returned no id");
  return id;
}

/**
 * Authoritative end-to-end check: can the broker actually sign in? This is the
 * source of truth for "ready", independent of the created-vs-existing path — an
 * existing account could have a different password or be unverified, and only a
 * real session request proves the printed credentials work. `POST /api/auth/sessions`
 * is a public endpoint (no admin/anon key needed).
 */
async function verifyLogin(
  cfg: AdminConfig,
  email: string,
  password: string,
): Promise<boolean> {
  const res = await adminFetch(authUrl(cfg, "sessions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const ok = res.ok;
  await res.text().catch(() => undefined);
  return ok;
}

/** Link broker -> importer; a duplicate (already linked) is success. */
async function ensureMembership(
  cfg: AdminConfig,
  importerId: string,
  userId: string,
): Promise<{ linked: boolean }> {
  const res = await adminFetch(recordsUrl(cfg, "importer_members"), {
    method: "POST",
    headers: { ...authHeaders(cfg), Prefer: "return=minimal" },
    body: JSON.stringify([{ importer_id: importerId, user_id: userId }]),
  });
  if (res.ok) return { linked: true };

  const text = await res.text();
  if (isAlreadyLinked(res.status, text)) return { linked: false };
  throw new Error(`[seed-demo] membership insert HTTP ${res.status}: ${text.slice(0, 300)}`);
}

async function main(): Promise<void> {
  const { email, password, importerName } = resolveDemoConfig();
  const cfg = resolveAdminConfig();
  console.log(`[seed-demo] provisioning against ${cfg.baseUrl}`);

  const broker = await ensureBroker(cfg, email, password);
  console.log(
    `[seed-demo] broker ${email} — ${broker.created ? "created" : "already existed"} (id ${broker.userId})`,
  );
  if (!broker.emailVerified) {
    console.warn(
      "[seed-demo] WARNING: broker email is NOT verified — autoConfirm may be disabled on this project. " +
        "Login will fail until the email is verified.",
    );
  }

  const importerId = await ensureImporter(cfg, importerName);
  console.log(`[seed-demo] importer "${importerName}" — id ${importerId}`);

  const { linked } = await ensureMembership(cfg, importerId, broker.userId);
  console.log(`[seed-demo] membership — ${linked ? "created" : "already linked"}`);

  const canLogin = await verifyLogin(cfg, email, password);
  if (!canLogin) {
    console.error(
      "\n[seed-demo] ✗ sign-in with these credentials FAILED (expected 200). The email may " +
        "already exist with a DIFFERENT password, or be unverified. Delete it " +
        "(DELETE /api/auth/users) and re-run, or set DEMO_PASSWORD to the existing one.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n[seed-demo] ✅ demo broker ready — sign-in verified (session issued). Log in with:");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  importer: ${importerName} (${importerId})`);
}

// Run only when invoked directly (not when imported by the unit test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
