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
 *   npx tsx scripts/embed-load.ts --limit=20    # smoke the first 20 HTS chunks (appends; see below)
 *   npx tsx scripts/embed-load.ts --batch=32                 # smaller embed/insert batches
 *
 * Credentials (server-only): NEXT_PUBLIC_INSFORGE_BASE_URL + the project API key
 * (INSFORGE_API_KEY, or the `api_key` in .insforge/project.json for local dev).
 * The API key is a full-access admin key that bypasses RLS — the corpus is
 * shared reference data loaded out-of-band, never written by a runtime request.
 *
 * Loud-failure contract (U4): a short embedding response, a per-batch insert
 * that persists fewer rows than sent, or a final table count that disagrees with
 * the number of chunks loaded all throw. Because a full load truncates first and
 * each batch auto-commits (no cross-batch transaction; the 500 MB free-tier cap
 * rules out staging a second copy), a mid-run failure is caught and the table is
 * emptied so the app never reads a *silently partial* corpus — a re-run restores
 * it. A hard kill (SIGKILL) can still leave the table partial; re-run to recover.
 * The pure core (`batch`/`toRows`/`loadCorpus`) is dependency-injected so this
 * contract is unit-tested without a network or database.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readJsonl, withRetry } from "@/lib/corpus-io";
import {
  adminFetch,
  authHeaders,
  resolveAdminConfig,
  type AdminConfig,
} from "@/lib/insforge-admin";
import { DEFAULT_EMBEDDING_MODEL, embedTexts } from "@/lib/llm";

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
  embedding_model: string;
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
 * chunks and embeddings would misattribute vectors, so it throws. `model` is the
 * embedding model actually used, stamped per row so the `embedding_model` column
 * reflects reality (not the SQL default) and the re-embed mitigation can trust it.
 */
export function toRows(
  chunks: readonly CorpusChunk[],
  embeddings: number[][],
  model: string,
): DocumentRow[] {
  if (chunks.length !== embeddings.length) {
    throw new Error(
      `[embed-load] embedding count ${embeddings.length} != chunk count ${chunks.length}`,
    );
  }
  return chunks.map((c, i) => ({
    content: c.content,
    embedding: embeddings[i],
    embedding_model: model,
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
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<{ embedded: number; inserted: number }> {
  const groups = batch(chunks, batchSize);
  let embedded = 0;
  let inserted = 0;

  for (let b = 0; b < groups.length; b++) {
    const group = groups[b];
    const embeddings = await deps.embed(group.map((c) => c.content));
    const rows = toRows(group, embeddings, model);
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
  let limit: number | null = null;
  let truncateFlag: boolean | null = null; // null = not explicitly set

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
      truncateFlag = true;
    } else if (key === "no-truncate") {
      truncateFlag = false;
    } else {
      throw new Error(
        `Unrecognized argument: ${JSON.stringify(arg)}. ` +
          `Supported: --files=<a,b> --batch=<n> --limit=<n> --truncate --no-truncate`,
      );
    }
  }

  // A full run truncates by default (replace the corpus). But a subset run
  // (`--limit`) defaults to append: silently wiping all ~24k rows to load 20 is
  // a data-loss footgun, so wiping during a subset run requires an explicit
  // `--truncate`. When the flag is set either way, honor it verbatim.
  const truncate = truncateFlag ?? limit === null;
  return { files, batchSize, truncate, limit };
}

/**
 * InsForge exposes a PostgREST proxy at `/api/database/records/<table>`. Admin
 * config resolution, the `Bearer` auth header, and the timeout-bounded fetch are
 * shared with the retriever in `@/lib/insforge-admin` (and the reason we bypass
 * the SDK). This module keeps only the record-endpoint URL shaping.
 */
function recordsUrl(cfg: AdminConfig, query = ""): string {
  return `${cfg.baseUrl}/api/database/records/${TABLE}${query}`;
}

/** Row total from a PostgREST `Content-Range` header ("start-end/total", e.g. "0-63/64"). */
function contentRangeTotal(res: Response): number {
  const total = res.headers.get("content-range")?.split("/")[1];
  const n = total ? Number.parseInt(total, 10) : NaN;
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Insert a batch, returning the number of rows the server persisted. Uses
 * `return=minimal, count=exact` so the count comes from the `Content-Range`
 * header — echoing full rows back (`return=representation`) would drag every
 * 1536-dim vector across the wire (~148 MB over the corpus) just to count them.
 */
async function insertRows(cfg: AdminConfig, rows: DocumentRow[]): Promise<number> {
  const res = await adminFetch(recordsUrl(cfg), {
    method: "POST",
    headers: { ...authHeaders(cfg), Prefer: "return=minimal, count=exact" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    throw new Error(`insert HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return contentRangeTotal(res);
}

/** Delete every corpus row so a re-run replaces rather than duplicates. */
async function truncateTable(cfg: AdminConfig): Promise<void> {
  // PostgREST refuses an unfiltered delete; `id >= 0` matches all BIGSERIAL rows.
  const res = await adminFetch(recordsUrl(cfg, "?id=gte.0"), {
    method: "DELETE",
    headers: authHeaders(cfg),
  });
  if (!res.ok) {
    throw new Error(`failed to truncate ${TABLE}: HTTP ${res.status}`);
  }
}

/** Authoritative row count, independent of what the inserts reported. */
async function tableCount(cfg: AdminConfig): Promise<number> {
  const res = await adminFetch(recordsUrl(cfg, "?select=id&limit=1"), {
    method: "GET",
    headers: { ...authHeaders(cfg), Prefer: "count=exact" },
  });
  if (!res.ok) throw new Error(`failed to count ${TABLE}: HTTP ${res.status}`);
  return contentRangeTotal(res);
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
    await withRetry(() => truncateTable(cfg), `truncate ${TABLE}`);
    console.log(`[embed-load] truncated ${TABLE}`);
  }

  const deps: LoadDeps = {
    // embedMany owns intra-call retry/parallelism; withRetry adds a bounded outer
    // layer so a whole-batch gateway blip (429 storm, socket reset) is survivable
    // on an unattended run rather than aborting the load.
    embed: (texts) => withRetry(() => embedTexts(texts), `embed ${texts.length} texts`),
    insert: (rows) =>
      withRetry(() => insertRows(cfg, rows), `insert ${rows.length} rows into ${TABLE}`),
    onBatch: ({ inserted, total }) => {
      if (inserted % (batchSize * 10) === 0 || inserted === total) {
        console.log(`[embed-load]   ${inserted}/${total} rows loaded`);
      }
    },
  };

  let result: { embedded: number; inserted: number };
  try {
    result = await loadCorpus(toLoad, deps, batchSize);
  } catch (err) {
    // A truncating run already emptied the table, and batches auto-commit, so a
    // mid-load failure leaves a partial corpus. Fail SAFE to empty: an empty
    // table is an obvious "not loaded" state (retrieval plainly returns nothing),
    // whereas a partial one silently serves incomplete results. Best-effort — a
    // hard kill can't run this; re-run to recover either way.
    if (truncate) {
      await withRetry(() => truncateTable(cfg), `truncate ${TABLE} (rollback)`).catch(
        (rollbackErr) =>
          console.error(
            `[embed-load] WARNING: failed to empty a partially-loaded ${TABLE}; ` +
              `it may hold a partial corpus — re-run to restore. (${(rollbackErr as Error).message})`,
          ),
      );
    }
    throw err;
  }
  const { embedded, inserted } = result;

  // Cross-check against the table itself, not just what the inserts reported.
  const finalCount = await withRetry(() => tableCount(cfg), `count ${TABLE}`);
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
