/**
 * U9 — the retrieval-mode switch: one config flag selects the Task-6 arm.
 *
 *   - `dense`         → the U5 baseline (`createDenseRetriever`), the arm every
 *                       measurement is compared against.
 *   - `hybrid+rerank` → the advanced arm: hybrid RRF fusion (`hybrid.ts`) narrowed
 *                       by the Cohere cross-encoder (`rerank.ts`).
 *
 * BOTH arms expose the SAME `DenseRetriever` shape `(query, opts) => chunks`, so
 * they are interchangeable behind `createRetrieveTool` (U6's agent tool) and the
 * eval harness (U10) can run either against identical inputs — the whole point of
 * a switch rather than a fork.
 *
 * The default is `dense`: flipping to the advanced arm is an explicit,
 * env-driven production upgrade (`RETRIEVAL_MODE=hybrid+rerank`) made once U10
 * confirms the lift and a `COHERE_API_KEY` is set. Defaulting to dense keeps the
 * live agent's behaviour and cost unchanged — no Cohere call on the billable path
 * — until that decision is made. (The advanced arm still degrades gracefully to
 * fused-hybrid order if the key is absent, so an accidental flip can't hard-fail.)
 *
 * Task 7 adds a SECOND, orthogonal config axis: `QUERY_REWRITE` (`off` default)
 * wraps EITHER arm with a HyDE-style query rewrite (`rewrite.ts`) — retrieval-time
 * query transformation, independent of which retriever runs underneath. So a
 * production config is a (mode × rewrite) pair, and the eval harness A/Bs each axis
 * with the other held fixed.
 */
import {
  clampK,
  createDenseRetriever,
  DEFAULT_K,
  type DenseRetriever,
} from "@/lib/retrieval/dense";
import {
  CANDIDATE_POOL,
  createHybridRetriever,
  type HybridRetriever,
} from "@/lib/retrieval/hybrid";
import { createCohereRerank, rerankChunks, type RerankFn } from "@/lib/retrieval/rerank";
import {
  createLlmRewrite,
  resolveQueryRewrite,
  withQueryRewrite,
  type QueryRewriteMode,
  type RewriteFn,
} from "@/lib/retrieval/rewrite";

/** Re-export the Task-7 query-rewrite surface so callers (the eval harness, the
 *  agent tool) import the whole retrieval-config vocabulary from one module. */
export {
  resolveQueryRewrite,
  DEFAULT_QUERY_REWRITE_MODE,
  type QueryRewriteMode,
  type RewriteStrategy,
} from "@/lib/retrieval/rewrite";

/** The two Task-6 retrieval arms. `hybrid+rerank` is the advanced arm. */
export type RetrievalMode = "dense" | "hybrid+rerank";

/** The two modes, for the eval harness to iterate over both arms. */
export const RETRIEVAL_MODES: readonly RetrievalMode[] = ["dense", "hybrid+rerank"];

/** Conservative default: keep the measured baseline until the lift is proven. */
export const DEFAULT_RETRIEVAL_MODE: RetrievalMode = "dense";

/**
 * Resolve the retrieval mode from a raw flag value (defaults to the
 * `RETRIEVAL_MODE` env var). Accepts a few friendly aliases; an UNRECOGNIZED
 * value falls back to the safe baseline but WARNS, so a typo in the flag can't
 * silently ship the wrong arm.
 */
export function resolveRetrievalMode(
  raw: string | undefined = process.env.RETRIEVAL_MODE,
): RetrievalMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "dense" || v === "baseline") return "dense";
  if (v === "hybrid+rerank" || v === "hybrid" || v === "advanced") return "hybrid+rerank";
  console.warn(
    `[retrieval] unrecognized RETRIEVAL_MODE=${JSON.stringify(raw)}; defaulting to "${DEFAULT_RETRIEVAL_MODE}"`,
  );
  return DEFAULT_RETRIEVAL_MODE;
}

export interface AdvancedRetrieverDeps {
  /** Override the hybrid (fusion) stage; defaults to the live gateway + RPC transport. */
  hybrid?: HybridRetriever;
  /** Override the rerank transport; defaults to the live Cohere API. */
  rerank?: RerankFn;
  /** Candidates pulled from each arm before fusion; defaults to CANDIDATE_POOL. */
  candidatePool?: number;
  /**
   * Optional health sink, forwarded to `rerankChunks`: fired once per query when
   * the rerank degrades to fused-hybrid order (Cohere outage/timeout/missing key).
   * The eval harness wires this to a per-run counter so a degraded advanced arm is
   * flagged in the report rather than silently reported as reranked retrieval.
   */
  onRerankFallback?: () => void;
  /**
   * Task-7 query-rewrite lever (`lib/retrieval/rewrite.ts`), applied to BOTH modes.
   * Defaults to the `QUERY_REWRITE` env mode; the eval harness passes it explicitly
   * so the A/B holds the rest of the pipeline fixed. `off` (the default) leaves the
   * retriever untouched.
   */
  rewrite?: QueryRewriteMode;
  /** Override the rewrite transport (defaults to the live gateway); for tests. */
  rewriteFn?: RewriteFn;
  /**
   * Health sink fired once per query when the rewrite degrades to the ORIGINAL
   * query (gateway outage/timeout/missing key/empty output). The eval harness wires
   * this to a per-run counter so a degraded rewrite run is flagged rather than
   * silently reported as rewritten — mirroring `onRerankFallback`.
   */
  onRewriteFallback?: () => void;
}

/**
 * The advanced retriever: fuse (hybrid RRF) then rerank to the requested `k`.
 * `DenseRetriever`-compatible so it drops straight into `createRetrieveTool`. The
 * requested `k` (the agent's tool argument, default {@link DEFAULT_K}) is the
 * FINAL count after rerank; the fused pool it reranks over is `candidatePool`
 * (much larger) so the cross-encoder has room to promote the right line. Both
 * stages are injectable; the defaults are lazy so constructing this needs no keys.
 */
export function createAdvancedRetriever(deps: AdvancedRetrieverDeps = {}): DenseRetriever {
  const hybrid = deps.hybrid ?? createHybridRetriever();
  const rerank = deps.rerank ?? createCohereRerank();
  const candidatePool = deps.candidatePool ?? CANDIDATE_POOL;
  return async (query, opts = {}) => {
    const fused = await hybrid(query, { candidatePool, type: opts.type });
    const finalK = clampK(opts.k ?? DEFAULT_K);
    return rerankChunks(query, fused, finalK, { rerank, onFallback: deps.onRerankFallback });
  };
}

/**
 * Build the retriever for the given mode (defaults to the resolved env mode).
 * This is what U6's `createRetrieveTool` calls by default, and what U10 calls
 * per-arm to measure the baseline-vs-advanced lift on identical inputs.
 */
export function createConfiguredRetriever(
  mode: RetrievalMode = resolveRetrievalMode(),
  deps: AdvancedRetrieverDeps = {},
): DenseRetriever {
  // The rerank-health sink and candidate pool only apply to the advanced arm; the
  // dense baseline never reranks, so it has nothing to fall back FROM.
  const base = mode === "hybrid+rerank" ? createAdvancedRetriever(deps) : createDenseRetriever();
  // The query-rewrite lever (Task 7) wraps EITHER arm — it is retrieval-time query
  // transformation, orthogonal to which retriever runs underneath.
  const rewriteMode = deps.rewrite ?? resolveQueryRewrite();
  return withQueryRewrite(base, rewriteMode, {
    rewrite: deps.rewriteFn ?? createLlmRewrite(),
    onFallback: deps.onRewriteFallback,
  });
}
