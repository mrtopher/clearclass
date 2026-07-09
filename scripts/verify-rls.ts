/**
 * U11 — live RLS isolation gate (the DB-layer half of the auth verification).
 *
 * The app-layer gate (`app/api/chat` + `lib/auth`) is proven offline in vitest.
 * This script proves the DEFENSE-IN-DEPTH layer that survives an app bug: hit the
 * PostgREST proxy as the `anon` role (the unauthenticated public key) and confirm
 * the tenant tables — `classifications`, `importers`, `importer_members` — refuse
 * the read. It mirrors the out-of-band operational checks (`embed:load`,
 * `eval:recall`): pure decision logic here is unit-tested, the live run wires I/O.
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

  // A missing relation means the migration has not been applied — not a pass.
  if (
    status === 404 ||
    body.includes("does not exist") ||
    body.includes("could not find the table") ||
    (body.includes("relation") && body.includes("not exist"))
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
  anonKey: string;
}

function resolveAnonConfig(): AnonConfig {
  const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_BASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY;
  if (!baseUrl || !anonKey) {
    throw new Error(
      "[verify-rls] Set NEXT_PUBLIC_INSFORGE_BASE_URL and NEXT_PUBLIC_INSFORGE_ANON_KEY " +
        "(see .env.example / .env.local) to run the live isolation gate.",
    );
  }
  return { baseUrl, anonKey };
}

async function anonRead(cfg: AnonConfig, table: string): Promise<IsolationVerdict> {
  const url = `${cfg.baseUrl}/api/database/records/${table}?select=id&limit=1`;
  try {
    const res = await fetch(url, {
      headers: {
        // Present ONLY the public anon key — this is the unauthenticated principal.
        Authorization: `Bearer ${cfg.anonKey}`,
        apikey: cfg.anonKey,
      },
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
  console.log(`[verify-rls] anon isolation check against ${cfg.baseUrl}\n`);

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
