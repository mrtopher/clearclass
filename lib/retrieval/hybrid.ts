/**
 * U9 — hybrid retrieval: the LEXICAL arm + Reciprocal Rank Fusion.
 *
 * The advanced retriever (Task-6 "advanced" arm) fuses two candidate lists over
 * the SAME `documents` corpus:
 *   - DENSE  — the U5 pgvector cosine search (`match_documents`, reused verbatim
 *              via `createFetchSearch`), good at semantic/synonym matches.
 *   - LEXICAL — a `ts_rank` full-text search (`match_documents_lexical`, added in
 *              the U9 migration), good when an EXACT term matters ("of cotton",
 *              a specific tariff word) that a dense embedding can blur away.
 *
 * The two are combined by Reciprocal Rank Fusion (RRF), then the fused pool is
 * handed to the Cohere reranker (`lib/retrieval/rerank.ts`) to pick the final
 * top-k. This module owns the lexical transport + the fusion; `index.ts` wires
 * fusion → rerank into a single `DenseRetriever`-compatible retriever so the
 * retrieval-mode flag is a drop-in swap for the baseline.
 *
 * SDK-free by design, exactly like `dense.ts`: it talks to the PostgREST proxy
 * with `fetch` so the same module runs in the Next.js route AND under a plain tsx
 * eval script. The pure orchestration (`hybridRetrieve`) and fusion (`reciprocalRankFusion`)
 * are dependency-injected / pure, so they unit-test with fakes — no gateway, no DB.
 */
import {
  adminFetch,
  authHeaders,
  resolveAdminConfig,
  type AdminConfig,
} from "@/lib/insforge-admin";
import { embedTexts } from "@/lib/llm";
import {
  clampK,
  createFetchSearch,
  toRetrievedChunk,
  type CorpusType,
  type EmbedQuery,
  type RetrievedChunk,
  type SearchFn,
} from "@/lib/retrieval/dense";

/**
 * Size of the candidate pool pulled from EACH arm before fusion. The plan calls
 * for a top-20–30 candidate set; 30 gives the reranker enough breadth to reorder
 * a truly relevant line into the top-3 while staying a cheap DB read and a small
 * rerank payload.
 */
export const CANDIDATE_POOL = 30;

/**
 * RRF damping constant. The canonical value from the original RRF paper
 * (Cormack et al.): score = Σ 1/(RRF_K + rank). A larger constant flattens the
 * contribution of top ranks, letting agreement across BOTH arms outweigh a single
 * arm's confident #1 — which is exactly what we want when fusing a semantic and a
 * lexical ranking that disagree.
 */
export const RRF_K = 60;

/** Run the lexical (`ts_rank`) search, returning ranked chunks. Query-text based
 *  (the tsquery is built server-side), unlike the embedding-based dense {@link SearchFn}. */
export type LexicalSearchFn = (
  queryText: string,
  opts: { k: number; type?: CorpusType },
) => Promise<RetrievedChunk[]>;

export interface HybridRetrieveOptions {
  /** Candidates to pull from each arm before fusion; clamped like dense's k. Defaults to CANDIDATE_POOL. */
  candidatePool?: number;
  /** Restrict both arms to one corpus source; omit to search all three. */
  type?: CorpusType;
}

export interface HybridRetrieveDeps {
  embed: EmbedQuery;
  denseSearch: SearchFn;
  lexicalSearch: LexicalSearchFn;
}

/**
 * Reciprocal Rank Fusion over several ranked chunk lists. Each list contributes
 * `1/(k + rank)` (rank 1-based) to a chunk's fused score; a chunk absent from a
 * list contributes nothing from it. Chunks are deduped by `id`, keeping the FIRST
 * occurrence's object (callers pass `[dense, lexical]`, so a chunk found by both
 * keeps its dense record — the cosine `similarity` is more meaningful downstream
 * than a raw ts_rank). Ties break by ascending `id` so the fused order is fully
 * DETERMINISTIC for identical inputs (the plan's "flag changes results
 * deterministically" contract depends on this).
 */
export function reciprocalRankFusion(
  lists: readonly (readonly RetrievedChunk[])[],
  k: number = RRF_K,
): RetrievedChunk[] {
  const scores = new Map<number, number>();
  const chunks = new Map<number, RetrievedChunk>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const chunk = list[rank];
      scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (k + rank + 1));
      if (!chunks.has(chunk.id)) chunks.set(chunk.id, chunk);
    }
  }
  return [...chunks.values()].sort((a, b) => {
    const byScore = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
    return byScore !== 0 ? byScore : a.id - b.id;
  });
}

/**
 * Hybrid retrieval: embed the query, run the dense and lexical arms in parallel
 * over a candidate pool, and return the RRF-fused ranked pool (deduped). This is
 * the reranker's input; when the reranker is unavailable the caller can use this
 * fused order directly (the "rerank failure falls back to fused-hybrid order"
 * degradation). A blank / whitespace-only query short-circuits to `[]` WITHOUT
 * embedding, matching `denseRetrieve` — no vector, no billable embed call.
 */
export async function hybridRetrieve(
  query: string,
  opts: HybridRetrieveOptions,
  deps: HybridRetrieveDeps,
): Promise<RetrievedChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const poolK = clampK(opts.candidatePool ?? CANDIDATE_POOL);
  const embedding = await deps.embed(trimmed);
  const [dense, lexical] = await Promise.all([
    deps.denseSearch(embedding, { k: poolK, type: opts.type }),
    deps.lexicalSearch(trimmed, { k: poolK, type: opts.type }),
  ]);
  return reciprocalRankFusion([dense, lexical]);
}

const LEXICAL_RPC = "match_documents_lexical";

/**
 * Build a `LexicalSearchFn` that calls the `match_documents_lexical` RPC through
 * the PostgREST proxy. Mirrors `dense.ts#createFetchSearch`: a non-OK status or a
 * non-array body throws (a silent error body would otherwise read as "no lexical
 * matches" and quietly halve the hybrid signal). Rows are validated with the
 * shared `toRetrievedChunk` — the RPC returns the identical row shape on purpose.
 */
export function createFetchLexicalSearch(cfg: AdminConfig): LexicalSearchFn {
  return async (queryText, { k, type }) => {
    const res = await adminFetch(`${cfg.baseUrl}/api/database/rpc/${LEXICAL_RPC}`, {
      method: "POST",
      headers: authHeaders(cfg),
      body: JSON.stringify({
        query_text: queryText,
        match_count: k,
        filter_type: type ?? null,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[hybrid] ${LEXICAL_RPC} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error(
        `[hybrid] ${LEXICAL_RPC} expected an array of rows, got ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
    return body.map((r, i) => toRetrievedChunk(r, `${LEXICAL_RPC} row ${i}`));
  };
}

/** A ready-to-call hybrid retriever bound to its embed + dense + lexical transports. */
export type HybridRetriever = (
  query: string,
  opts?: HybridRetrieveOptions,
) => Promise<RetrievedChunk[]>;

/**
 * Wire the default hybrid retriever: embed via the gateway, dense-search via
 * `match_documents`, lexical-search via `match_documents_lexical`, all through the
 * resolved admin config. Every dep is overridable for tests / alternate
 * transports. Admin-config resolution is deferred to the first search so importing
 * this module never requires credentials (matching `createDenseRetriever`).
 *
 * The same admin-key transport note as `dense.ts` applies: `documents` is shared
 * reference data every broker reads identically, so the admin key (which bypasses
 * RLS) is correct here and is what the offline eval harness needs. Do NOT point
 * this at an owner-scoped table without injecting a JWT-built transport.
 */
export function createHybridRetriever(
  deps?: Partial<HybridRetrieveDeps>,
): HybridRetriever {
  const embed: EmbedQuery =
    deps?.embed ?? (async (text) => (await embedTexts([text]))[0]);
  let denseSearch = deps?.denseSearch;
  let lexicalSearch = deps?.lexicalSearch;
  return (query, opts = {}) => {
    if (!denseSearch || !lexicalSearch) {
      // Resolve the shared admin config once, then bind whichever arm wasn't
      // injected. Deferred to first call so import needs no credentials.
      const cfg = resolveAdminConfig();
      denseSearch ??= createFetchSearch(cfg);
      lexicalSearch ??= createFetchLexicalSearch(cfg);
    }
    return hybridRetrieve(query, opts, { embed, denseSearch, lexicalSearch });
  };
}
