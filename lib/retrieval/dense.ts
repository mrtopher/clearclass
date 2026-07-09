/**
 * U5 — baseline dense retriever.
 *
 * Embeds a query, runs a pgvector cosine top-k search over the U4 `documents`
 * corpus via the `match_documents` RPC, and returns ranked, citable chunks. This
 * is (a) the agent's retrieval tool (U6, wrapped in `lib/tools/retrieve.ts`),
 * (b) the Task-6 baseline arm the advanced retriever (U9) is measured against,
 * and (c) the engine behind the recall@k harness (`eval/retrieval-recall.ts`).
 *
 * SDK-free by design: it talks to InsForge's PostgREST proxy with `fetch`
 * (see `@/lib/insforge-admin`) so the very same module runs both inside the
 * Next.js server route AND under a plain tsx offline script, where @insforge/sdk
 * cannot load. The pure orchestration (`denseRetrieve`) is dependency-injected
 * over an `embed` + `search` pair, so it is unit-tested with fakes — no gateway,
 * no database — mirroring the U4 load's testing seam.
 */
import {
  adminFetch,
  authHeaders,
  resolveAdminConfig,
  type AdminConfig,
} from "@/lib/insforge-admin";
import { embedTexts } from "@/lib/llm";

/** The three corpus sources loaded in U2/U3 (`documents.type`). */
export type CorpusType = "hts" | "gri" | "ruling";

/** A retrieved corpus chunk with its citation metadata and cosine similarity. */
export interface RetrievedChunk {
  id: number;
  content: string;
  type: string;
  /** Per-type citation metadata (hts_code, ruling_number, rule, …). */
  metadata: Record<string, unknown>;
  /** 1 - cosine distance; higher is closer (in [-1, 1]). */
  similarity: number;
}

export interface DenseRetrieveOptions {
  /** Number of chunks to return; clamped to [1, MAX_K]. Defaults to DEFAULT_K. */
  k?: number;
  /** Restrict to one corpus source; omit to search all three. */
  type?: CorpusType;
}

/** Default top-k when a caller doesn't specify — enough context for GRI reasoning
 *  without flooding the agent prompt. */
export const DEFAULT_K = 8;
/** Upper bound so a stray/hostile `k` can't ask the DB for the whole corpus. */
export const MAX_K = 50;

/** Embed one query string into its vector. */
export type EmbedQuery = (text: string) => Promise<number[]>;
/** Run the cosine top-k search over `documents`, returning ranked chunks. */
export type SearchFn = (
  embedding: number[],
  opts: { k: number; type?: CorpusType },
) => Promise<RetrievedChunk[]>;

export interface DenseRetrieveDeps {
  embed: EmbedQuery;
  search: SearchFn;
}

/** Clamp a requested `k` into [1, MAX_K]; a non-finite value falls back to DEFAULT_K. */
export function clampK(k: number): number {
  if (!Number.isFinite(k)) return DEFAULT_K;
  return Math.max(1, Math.min(MAX_K, Math.floor(k)));
}

/**
 * Dense top-k retrieval. A blank / whitespace-only query short-circuits to `[]`
 * WITHOUT embedding — an empty query has no meaningful vector, and skipping it
 * keeps both the agent tool and the recall harness from spending a gateway call
 * (and surfacing arbitrary nearest neighbours) on an empty box. This is the
 * "edge — an empty/garbage query returns no results without throwing" scenario.
 */
export async function denseRetrieve(
  query: string,
  opts: DenseRetrieveOptions,
  deps: DenseRetrieveDeps,
): Promise<RetrievedChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const k = clampK(opts.k ?? DEFAULT_K);
  const embedding = await deps.embed(trimmed);
  return deps.search(embedding, { k, type: opts.type });
}

/**
 * Validate one row returned by the `match_documents` RPC into a `RetrievedChunk`.
 * A malformed row (missing id/content, non-object metadata, non-numeric
 * similarity) throws with its position rather than surfacing a half-built
 * citation the agent would then present as authoritative.
 */
export function toRetrievedChunk(value: unknown, where: string): RetrievedChunk {
  const v = value as Partial<RetrievedChunk> | null;
  if (!v || typeof v !== "object") {
    throw new Error(`[dense] ${where}: expected a result row object, got ${typeof value}`);
  }
  if (typeof v.id !== "number") {
    throw new Error(`[dense] ${where}: row is missing a numeric id`);
  }
  if (typeof v.content !== "string" || !v.content) {
    throw new Error(`[dense] ${where}: row is missing content`);
  }
  if (typeof v.type !== "string" || !v.type) {
    throw new Error(`[dense] ${where}: row is missing type`);
  }
  if (!v.metadata || typeof v.metadata !== "object") {
    throw new Error(`[dense] ${where}: row metadata must be an object`);
  }
  if (typeof v.similarity !== "number") {
    throw new Error(`[dense] ${where}: row is missing a numeric similarity`);
  }
  return v as RetrievedChunk;
}

const MATCH_RPC = "match_documents";

/**
 * Build a `SearchFn` that calls the `match_documents` RPC through the PostgREST
 * proxy. The 1536-float query vector is sent as a plain JSON number array —
 * pgvector accepts that for its `vector` input. A non-OK status or a
 * non-array body throws (a silent `{}` error body would otherwise read as
 * "no matches").
 */
export function createFetchSearch(cfg: AdminConfig): SearchFn {
  return async (embedding, { k, type }) => {
    const res = await adminFetch(`${cfg.baseUrl}/api/database/rpc/${MATCH_RPC}`, {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify({
        query_embedding: embedding,
        match_count: k,
        filter_type: type ?? null,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[dense] ${MATCH_RPC} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error(
        `[dense] ${MATCH_RPC} expected an array of rows, got ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    return body.map((r, i) => toRetrievedChunk(r, `${MATCH_RPC} row ${i}`));
  };
}

/** A ready-to-call dense retriever bound to its embed + search transport. */
export type DenseRetriever = (
  query: string,
  opts?: DenseRetrieveOptions,
) => Promise<RetrievedChunk[]>;

/**
 * Wire the default dense retriever: embed via the gateway (`embedTexts`), search
 * via the `match_documents` RPC using the resolved admin config. Both deps are
 * overridable for tests / alternate transports. Admin-config resolution is
 * deferred to the first search so importing this module (e.g. to reuse the pure
 * helpers, or to construct the agent tool) never requires credentials.
 *
 * NOTE on the default transport: `resolveAdminConfig()` uses the admin key, which
 * BYPASSES RLS. That is correct here because `documents` is shared reference data
 * every broker reads identically (there is no per-importer corpus row), and it is
 * what the offline recall harness needs. It is NOT a per-user-scoped transport:
 * if this retriever is ever pointed at an owner-scoped table, the caller MUST
 * inject a `search` built from the request's JWT (U11) instead of relying on this
 * admin default — otherwise RLS would silently not apply. Per-importer isolation
 * lives on `classifications` (U7), never on the corpus.
 */
export function createDenseRetriever(deps?: Partial<DenseRetrieveDeps>): DenseRetriever {
  const embed: EmbedQuery = deps?.embed ?? (async (text) => (await embedTexts([text]))[0]);
  let search = deps?.search;
  return (query, opts = {}) => {
    search ??= createFetchSearch(resolveAdminConfig());
    return denseRetrieve(query, opts, { embed, search });
  };
}
