/**
 * U4 — embedding generation + pgvector load (offline, scripted).
 *
 * Reads the JSONL corpus artifacts produced by U2/U3 (HTS leaves, GRI rules,
 * CBP rulings), embeds each chunk's `content` through the gateway
 * (`text-embedding-3-small`, KTD9), and loads the rows into the `documents`
 * pgvector table created by the U4 migration. Retrieval (the cosine `match`
 * RPC) is U5's job — this stage only populates a searchable store.
 *
 * Usage:
 *   npm run embed:load                          # full corpus -> documents (truncates first)
 *   npx tsx scripts/embed-load.ts --limit=20 --no-truncate   # smoke a subset, append
 *   npx tsx scripts/embed-load.ts --batch=32                 # smaller embed/insert batches
 *
 * Credentials (server-only): NEXT_PUBLIC_INSFORGE_BASE_URL + the project API key
 * (INSFORGE_API_KEY, or the `api_key` in .insforge/project.json for local dev).
 * The API key is a full-access admin key that bypasses RLS — the corpus is
 * shared reference data loaded out-of-band, never written by a runtime request.
 *
 * Loud-failure contract (U4): a short embedding response, a per-batch insert
 * that persists fewer rows than sent, or a final table count that disagrees
 * with the number of chunks loaded all throw — the corpus is never left silently
 * partial. The pure core (`batch`/`toRows`/`loadCorpus`) is dependency-injected
 * so this contract is unit-tested without a network or database.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readJsonl, withRetry } from "@/lib/corpus-io";
import { embedTexts } from "@/lib/llm";

/** Canonical corpus artifacts produced by U2/U3. */
const DEFAULT_CORPUS_FILES = [
  "data/hts-chunks.jsonl",
  "data/gri-chunks.jsonl",
  "data/ruling-chunks.jsonl",
];
/**
 * Rows per embed + insert request. Each row carries a 1536-float vector
 * (~15 KB serialized), so 64 keeps a batch request near ~1 MB — well under
 * request-body limits while amortizing round-trips over the ~24k-chunk corpus.
 */
const DEFAULT_BATCH_SIZE = 64;
const TABLE = "documents";

/** A corpus chunk as written by the U2/U3 ingest scripts. */
export interface CorpusChunk {
  content: string;
  type: string;
  metadata: Record<string, unknown>;
}

/** A row ready for insertion into `public.documents`. */
export interface DocumentRow {
  content: string;
  embedding: number[];
  type: string;
  metadata: Record<string, unknown>;
}

/** Split `items` into consecutive groups of at most `size` (last may be short). */
export function batch<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`batch size must be >= 1, got ${size}`);
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

/**
 * Validate a value parsed from a JSONL corpus line into a `CorpusChunk`. A
 * missing/blank `content`, missing `type`, or non-object `metadata` throws with
 * the source position, so a corrupt or empty artifact fails loudly rather than
 * embedding blank text or loading a malformed row.
 */
export function assertChunk(value: unknown, where: string): CorpusChunk {
  const v = value as Partial<CorpusChunk> | null;
  if (!v || typeof v !== "object") {
    throw new Error(`[embed-load] ${where}: expected a chunk object, got ${typeof value}`);
  }
  if (typeof v.content !== "string" || !v.content.trim()) {
    throw new Error(`[embed-load] ${where}: chunk has empty or non-string content`);
  }
  if (typeof v.type !== "string" || !v.type) {
    throw new Error(`[embed-load] ${where}: chunk has missing or non-string type`);
  }
  if (!v.metadata || typeof v.metadata !== "object") {
    throw new Error(`[embed-load] ${where}: chunk metadata must be an object`);
  }
  return v as CorpusChunk;
}

/**
 * Zip a batch of chunks with their embeddings into insertable rows. The 1:1
 * length check is the core no-silent-drop guard: a positional mismatch between
 * chunks and embeddings would misattribute vectors, so it throws.
 */
export function toRows(chunks: readonly CorpusChunk[], embeddings: number[][]): DocumentRow[] {
  if (chunks.length !== embeddings.length) {
    throw new Error(
      `[embed-load] embedding count ${embeddings.length} != chunk count ${chunks.length}`,
    );
  }
  return chunks.map((c, i) => ({
    content: c.content,
    embedding: embeddings[i],
    type: c.type,
    metadata: c.metadata,
  }));
}

export interface LoadDeps {
  /** Embed a batch of texts, returning one vector per text in input order. */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Persist a batch of rows, returning the number actually inserted. */
  insert: (rows: DocumentRow[]) => Promise<number>;
  /** Optional per-batch progress callback. */
  onBatch?: (info: { batchIndex: number; batchCount: number; inserted: number; total: number }) => void;
}

/**
 * Embed and load every chunk, batch by batch. Returns the embedded/inserted
 * totals; throws if any batch persists fewer rows than sent, or if the grand
 * total inserted disagrees with the number of chunks — the corpus is all-or-
 * loudly-nothing, never silently partial.
 */
export async function loadCorpus(
  chunks: readonly CorpusChunk[],
  deps: LoadDeps,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<{ embedded: number; inserted: number }> {
  const groups = batch(chunks, batchSize);
  let embedded = 0;
  let inserted = 0;

  for (let b = 0; b < groups.length; b++) {
    const group = groups[b];
    const embeddings = await deps.embed(group.map((c) => c.content));
    const rows = toRows(group, embeddings);
    embedded += embeddings.length;

    const n = await deps.insert(rows);
    if (n !== rows.length) {
      throw new Error(
        `[embed-load] batch ${b + 1}/${groups.length}: inserted ${n} of ${rows.length} rows — ` +
          `refusing to continue with a silently partial corpus`,
      );
    }
    inserted += n;
    deps.onBatch?.({ batchIndex: b, batchCount: groups.length, inserted, total: chunks.length });
  }

  if (inserted !== chunks.length) {
    throw new Error(
      `[embed-load] loaded ${inserted} rows but had ${chunks.length} chunks — corpus is partial`,
    );
  }
  return { embedded, inserted };
}

// ── CLI / IO shell ────────────────────────────────────────────────────────────

export interface Args {
  files: string[];
  batchSize: number;
  truncate: boolean;
  limit: number | null;
}

export function parseArgs(argv: string[]): Args {
  let files = DEFAULT_CORPUS_FILES;
  let batchSize = DEFAULT_BATCH_SIZE;
  let truncate = true;
  let limit: number | null = null;

  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "files" && value) {
      files = value.split(",").map((f) => f.trim()).filter(Boolean);
    } else if (key === "batch" && value) {
      batchSize = Number.parseInt(value, 10);
      if (Number.isNaN(batchSize) || batchSize < 1) {
        throw new Error(`Invalid --batch value: ${JSON.stringify(value)} (expected a positive integer)`);
      }
    } else if (key === "limit" && value) {
      limit = Number.parseInt(value, 10);
      if (Number.isNaN(limit) || limit < 1) {
        throw new Error(`Invalid --limit value: ${JSON.stringify(value)} (expected a positive integer)`);
      }
    } else if (key === "truncate") {
      truncate = true;
    } else if (key === "no-truncate") {
      truncate = false;
    } else {
      throw new Error(
        `Unrecognized argument: ${JSON.stringify(arg)}. ` +
          `Supported: --files=<a,b> --batch=<n> --limit=<n> --truncate --no-truncate`,
      );
    }
  }
  return { files, batchSize, truncate, limit };
}

/** Resolve the admin base URL + API key, preferring env, then .insforge/project.json. */
function resolveAdminConfig(): { baseUrl: string; apiKey: string } {
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
      "[embed-load] Insforge admin config missing. Set NEXT_PUBLIC_INSFORGE_BASE_URL and " +
        "INSFORGE_API_KEY (server-only), or run `npx @insforge/cli link` so " +
        ".insforge/project.json is present. See .env.example.",
    );
  }
  return { baseUrl, apiKey };
}

interface AdminConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * InsForge exposes a PostgREST proxy at `/api/database/records/<table>`. We talk
 * to it directly with `fetch` rather than through `@insforge/sdk`: the SDK's
 * bundle `require()`s `@insforge/shared-schemas`, which ships only an ESM
 * `export` condition, so it loads under Next's bundler but NOT under a plain
 * tsx/Node offline script. The admin API key authenticates as `Bearer` and
 * bypasses RLS — correct for this out-of-band shared-corpus load.
 */
function recordsUrl(cfg: AdminConfig, query = ""): string {
  return `${cfg.baseUrl}/api/database/records/${TABLE}${query}`;
}

function authHeaders(cfg: AdminConfig): Record<string, string> {
  return { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };
}

/** Insert a batch, returning the number of rows the server actually persisted. */
async function insertRows(cfg: AdminConfig, rows: DocumentRow[]): Promise<number> {
  const res = await fetch(recordsUrl(cfg), {
    method: "POST",
    headers: { ...authHeaders(cfg), Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`insert HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as unknown[];
  return Array.isArray(data) ? data.length : 0;
}

/** Delete every corpus row so a re-run replaces rather than duplicates. */
async function truncateTable(cfg: AdminConfig): Promise<void> {
  // PostgREST refuses an unfiltered delete; `id >= 0` matches all BIGSERIAL rows.
  const res = await fetch(recordsUrl(cfg, "?id=gte.0"), {
    method: "DELETE",
    headers: authHeaders(cfg),
  });
  if (!res.ok) {
    throw new Error(`[embed-load] failed to truncate ${TABLE}: HTTP ${res.status}`);
  }
}

/** Authoritative row count, independent of what the inserts reported. */
async function tableCount(cfg: AdminConfig): Promise<number> {
  const res = await fetch(recordsUrl(cfg, "?select=id&limit=1"), {
    headers: { ...authHeaders(cfg), Prefer: "count=exact" },
  });
  if (!res.ok) throw new Error(`[embed-load] failed to count ${TABLE}: HTTP ${res.status}`);
  // Content-Range is "start-end/total", e.g. "0-0/23707".
  const total = res.headers.get("content-range")?.split("/")[1];
  return total ? Number.parseInt(total, 10) : 0;
}

async function main(): Promise<void> {
  const { files, batchSize, truncate, limit } = parseArgs(process.argv.slice(2));

  const chunks: CorpusChunk[] = [];
  for (const file of files) {
    const absPath = resolve(process.cwd(), file);
    const raw = await readJsonl<unknown>(absPath);
    const parsed = raw.map((r, i) => assertChunk(r, `${file}:${i + 1}`));
    chunks.push(...parsed);
    console.log(`[embed-load] ${file}: ${parsed.length} chunks`);
  }

  const toLoad = limit ? chunks.slice(0, limit) : chunks;
  if (toLoad.length === 0) {
    throw new Error("[embed-load] no chunks to load — aborting.");
  }
  console.log(
    `[embed-load] loading ${toLoad.length} chunks in batches of ${batchSize}` +
      (limit ? ` (--limit=${limit})` : "") +
      (truncate ? " (truncating first)" : " (append)"),
  );

  const cfg = resolveAdminConfig();

  if (truncate) {
    await truncateTable(cfg);
    console.log(`[embed-load] truncated ${TABLE}`);
  }

  const deps: LoadDeps = {
    // embedMany (inside embedTexts) owns embed retry/backoff and parallelism.
    embed: (texts) => embedTexts(texts),
    insert: (rows) =>
      withRetry(() => insertRows(cfg, rows), `insert ${rows.length} rows into ${TABLE}`),
    onBatch: ({ inserted, total }) => {
      if (inserted % (batchSize * 10) === 0 || inserted === total) {
        console.log(`[embed-load]   ${inserted}/${total} rows loaded`);
      }
    },
  };

  const { embedded, inserted } = await loadCorpus(toLoad, deps, batchSize);

  // Cross-check against the table itself, not just what the inserts reported.
  const finalCount = await tableCount(cfg);
  const expected = truncate ? inserted : "(appended; see table)";
  console.log(
    `\n[embed-load] done: embedded ${embedded}, inserted ${inserted}; ` +
      `table now holds ${finalCount} rows (expected ${expected}).`,
  );
  if (truncate && finalCount !== inserted) {
    throw new Error(
      `[embed-load] table count ${finalCount} != inserted ${inserted} after a truncating load — ` +
        `a concurrent writer or a silent drop occurred.`,
    );
  }
}

// Only run when invoked directly (not when imported by tests), so importing the
// pure helpers never triggers a live embed or DB write.
const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
