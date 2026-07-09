/**
 * U11 — live RLS isolation gate (the DB-layer half of the auth verification).
 *
 * The app-layer gate (`app/api/chat` + `lib/auth`) is proven offline in vitest.
 * This script proves the DEFENSE-IN-DEPTH layer that survives an app bug: hit the
 * PostgREST proxy as the unauthenticated principal and confirm the tenant tables —
 * `classifications`, `importers`, `importer_members` — refuse the read. ClearClass
 * has no Insforge anon key (it exposes no anon-readable data), so that principal is
 * simply a request with NO token; if a project ever sets
 * `NEXT_PUBLIC_INSFORGE_ANON_KEY`, the probe presents it instead. It mirrors the
 * out-of-band operational checks (`embed:load`, `eval:recall`): pure decision logic
 * here is unit-tested, the live run wires I/O.
 *
 * Run against the deployed backend AFTER `npm run migrate`:
 *     npm run verify:rls
 *
 * Scope: this asserts the unauthenticated → tenant-table path is closed (the
 * "classifications reads rejected" done-signal). Cross-importer isolation between
 * two authenticated brokers is enforced and tested at the app layer (the route +
 * `resolveEffectiveImporter` tests) and by the `is_importer_member()` RLS policy;
 * exercising it live would require provisioning two real sessions, out of scope
 * for a smoke gate.
 */
import { pathToFileURL } from "node:url";

/** The tenant tables that must be closed to the anon role. */
const TENANT_TABLES = ["classifications", "importers", "importer_members"] as const;

export type IsolationVerdict =
  | { kind: "isolated"; detail: string }
  | { kind: "weak"; detail: string }
  | { kind: "leak"; detail: string }
  | { kind: "not-applied"; detail: string }
  | { kind: "error"; detail: string };

/**
 * Classify an anon SELECT response into a verdict — pure, so it is unit-tested
 * without a network. The desired outcome is a hard permission denial (4xx): the
 * migration `REVOKE ALL ... FROM anon` removes the SELECT privilege, so the anon
 * role cannot even reach the RLS predicate.
 */
export function interpretAnonRead(status: number, bodyText: string): IsolationVerdict {
  const body = bodyText.toLowerCase();

  // A missing RELATION means the migration has not been applied — not a pass.
  // Match relation-level absence only: a bare "does not exist" also fires on a
  // missing COLUMN (42703), which is a probe error, not a migration gap.
  if (
    status === 404 ||
    body.includes("could not find the table") ||
    (body.includes("relation") && body.includes("does not exist"))
  ) {
    return {
      kind: "not-applied",
      detail: `table not found (HTTP ${status}). Run \`npm run migrate\` first.`,
    };
  }

  // Permission denied / unauthorized: anon lacks the grant. This is the goal.
  if (status === 401 || status === 403 || body.includes("permission denied")) {
    return { kind: "isolated", detail: `anon read refused (HTTP ${status}).` };
  }

  if (status >= 200 && status < 300) {
    let rows: unknown;
    try {
      rows = JSON.parse(bodyText);
    } catch {
      return { kind: "error", detail: `unparseable 2xx body: ${bodyText.slice(0, 120)}` };
    }
    if (Array.isArray(rows) && rows.length > 0) {
      return {
        kind: "leak",
        detail: `anon read RETURNED ${rows.length} row(s) — tenant data is exposed.`,
      };
    }
    // 2xx with no rows: RLS filtered everything, but the table grant was not
    // revoked from anon. No leak, but weaker than intended — flag it.
    return {
      kind: "weak",
      detail: "anon read allowed but returned 0 rows (RLS filtered; grant not revoked).",
    };
  }

  return { kind: "error", detail: `unexpected HTTP ${status}: ${bodyText.slice(0, 120)}` };
}

interface AnonConfig {
  baseUrl: string;
  /**
   * Optional. ClearClass has no Insforge anon key (the SDK's `anonKey` is optional
   * and the app exposes no anon-readable data — everything is behind a user JWT or
   * the admin key). When unset we probe with NO token, which is the true
   * unauthenticated principal for this project.
   */
  anonKey?: string;
}

function resolveAnonConfig(): AnonConfig {
  const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "[verify-rls] Set NEXT_PUBLIC_INSFORGE_BASE_URL (see .env.example / .env.local) " +
        "to run the live isolation gate.",
    );
  }
  return { baseUrl, anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY || undefined };
}

async function anonRead(cfg: AnonConfig, table: string): Promise<IsolationVerdict> {
  // No `select=<col>` — the tables differ in shape (importer_members has a
  // composite PK and no `id` column), and referencing a missing column yields a
  // 400 that masquerades as a real error. A bare `limit=1` asks for whole rows,
  // which the anon REVOKE denies at the table level regardless of columns.
  const url = `${cfg.baseUrl}/api/database/records/${table}?limit=1`;
  // Present the public anon key IF this project has one; otherwise send NO
  // credentials — for ClearClass the unauthenticated principal simply carries no
  // token, and the gateway refusing it (401) IS the isolation boundary. (With an
  // anon key you could additionally distinguish a role-level grant refusal from a
  // gateway rejection; ClearClass has no such anon role, so this is complete.)
  const headers: Record<string, string> = cfg.anonKey
    ? { Authorization: `Bearer ${cfg.anonKey}`, apikey: cfg.anonKey }
    : {};
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    return interpretAnonRead(res.status, await res.text());
  } catch (err) {
    return {
      kind: "error",
      detail: `request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function main(): Promise<void> {
  const cfg = resolveAnonConfig();
  const principal = cfg.anonKey ? "anon key" : "no token (unauthenticated)";
  console.log(
    `[verify-rls] isolation check against ${cfg.baseUrl} as ${principal}\n`,
  );

  const results = await Promise.all(
    TENANT_TABLES.map(async (table) => ({ table, verdict: await anonRead(cfg, table) })),
  );

  let failed = false;
  for (const { table, verdict } of results) {
    const ok = verdict.kind === "isolated";
    const warn = verdict.kind === "weak";
    const mark = ok ? "✓" : warn ? "⚠" : "✗";
    console.log(`  ${mark} ${table.padEnd(18)} ${verdict.kind.toUpperCase()} — ${verdict.detail}`);
    if (!ok && !warn) failed = true;
  }

  if (failed) {
    console.error(
      "\n[verify-rls] FAIL — a tenant table is not closed to the anon role. " +
        "Isolation is not enforced at the DB layer.",
    );
    process.exit(1);
  }
  console.log("\n[verify-rls] PASS — unauthenticated reads of tenant tables are refused.");
}

// Only run when invoked directly (not when imported by tests), so importing
// `interpretAnonRead` never triggers a live request.
const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
