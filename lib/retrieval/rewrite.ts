/**
 * Task 7 (#1) — query-side rewriting: the retrieval-RANKING lever.
 *
 * The eval localized the dominant classification error to retrieval RANKING, not
 * corpus coverage: every HTS code already exists in the corpus as a tariff
 * leaf-line chunk, so the gold chunk is never missing — the retriever just fails
 * to rank a terse tariff line ("Live horses … > Purebred breeding animals >
 * Males") above near-misses for a natural-language product description ("What is
 * the HTS code for a purebred stallion imported for breeding?"). Query and corpus
 * are written in two different registers, so their embeddings land in different
 * neighbourhoods.
 *
 * This closes that register gap with a HyDE-style rewrite (Gao et al.,
 * "Precise Zero-Shot Dense Retrieval without Relevance Labels"): a cheap LLM turns
 * the product description into the concise "tariff-ese" a classification heading
 * is written in — material/composition, form, principal use — and THAT text drives
 * retrieval. The hypothetical heading embeds nearer the real tariff lines than the
 * question ever could. Two compose strategies (measured, see SUBMISSION §6.4):
 *   - `hyde`   — retrieve on the rewrite ALONE (pure HyDE).
 *   - `expand` — retrieve on `original + rewrite` (query expansion): keeps the
 *                product's exact distinguishing terms (specs, origin) AND adds the
 *                tariff vocabulary, so it also feeds the lexical arm.
 *
 * It is RETRIEVAL-TIME only — no corpus reload, so no DB-OOM risk (the HNSW-bloat
 * hazard is ingest-only). It wraps ANY configured retriever (`withQueryRewrite`),
 * so it composes with both the dense baseline and the `hybrid+rerank` arm and is
 * measured by the same recall@k / e2e harness. Ships behind `QUERY_REWRITE` (off
 * by default), the reproducible A/B seam mirroring `RETRIEVAL_MODE` /
 * `AGENT_RESELECT`.
 *
 * Sibling to `rerank.ts` in its ONE load-bearing contract: DEGRADE, DON'T CRASH.
 * A rewrite failure — gateway outage, missing key, timeout, empty output — falls
 * back to the ORIGINAL query so retrieval is never WORSE than the un-rewritten
 * baseline. SERVER-ONLY (reads the gateway key via `chatModel`). The pure core
 * (`buildRewritePrompt`, `composeQuery`, `rewriteQuery`) is dependency-injected
 * over a `RewriteFn`, so it unit-tests with fakes — no gateway.
 */
import { generateText } from "ai";

import { chatModel } from "@/lib/llm";
import type { DenseRetriever, DenseRetrieveOptions } from "@/lib/retrieval/dense";

/** How the rewrite is combined with the original query before retrieval. */
export type RewriteStrategy = "hyde" | "expand";

/** The query-rewrite mode. `off` disables the lever (production default). */
export type QueryRewriteMode = "off" | RewriteStrategy;

/** Conservative default: keep the un-rewritten query until the lift is proven. */
export const DEFAULT_QUERY_REWRITE_MODE: QueryRewriteMode = "off";

/**
 * Resolve the query-rewrite mode from a raw flag value (defaults to the
 * `QUERY_REWRITE` env var). Bare `on`/`true` maps to `expand` (the lower-variance
 * strategy — it never DROPS the original query's terms). An UNRECOGNIZED value
 * falls back to `off` but WARNS, so a typo can't silently ship the wrong arm —
 * matching `resolveRetrievalMode` / `resolveReselect`.
 */
export function resolveQueryRewrite(
  raw: string | undefined = process.env.QUERY_REWRITE,
): QueryRewriteMode {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "off" || v === "false" || v === "0" || v === "baseline") return "off";
  if (v === "hyde") return "hyde";
  if (v === "expand" || v === "on" || v === "true" || v === "1") return "expand";
  console.warn(
    `[rewrite] unrecognized QUERY_REWRITE=${JSON.stringify(raw)}; defaulting to "${DEFAULT_QUERY_REWRITE_MODE}"`,
  );
  return DEFAULT_QUERY_REWRITE_MODE;
}

/** Rewrite one query into tariff-line phrasing. Injectable for tests. */
export type RewriteFn = (query: string) => Promise<string>;

export interface RewriteDeps {
  rewrite: RewriteFn;
  /**
   * Optional health sink, fired ONCE per query whenever the rewrite degrades to
   * the ORIGINAL query because the LLM did not produce a usable rewrite (an
   * outage/timeout/missing-key throw, or an empty/whitespace response). NOT fired
   * for the blank-query early return (nothing to rewrite). The eval harness counts
   * these so a degraded run (e.g. gateway rate-limited) is LOUD in the report
   * instead of silently reporting un-rewritten numbers as "rewritten".
   */
  onFallback?: () => void;
}

/** Hard wall-clock bound on a single rewrite call, so a hung gateway can't stall
 *  the billable classification — the timeout surfaces as an error that
 *  `rewriteQuery` turns into graceful original-query degradation. */
export const REWRITE_TIMEOUT_MS = 10_000;

/** Cap the rewrite output: a classification heading is a phrase, not an essay. A
 *  runaway generation (or a model that ignores the instruction and explains
 *  itself) is truncated so it can't dominate the embedding with prose. */
export const MAX_REWRITE_CHARS = 600;

/**
 * The rewrite instruction. Steers the model toward the three axes an HTS heading
 * actually turns on — MATERIAL/composition, FORM/state, principal USE/function —
 * and to preserve concrete distinguishing details (specs, origin, dimensions) so
 * the rewrite can't blur away the very terms that decide a subheading. "Output
 * only the phrase" keeps prose out of the embedding.
 */
export const REWRITE_SYSTEM_PROMPT =
  "You rewrite a product description into the concise, formal style of a customs " +
  "tariff (HTS) classification heading, to improve retrieval against a tariff corpus. " +
  "State, in order: the material or composition; the form or state; and the principal " +
  "use or function. Preserve every concrete distinguishing detail (specific materials, " +
  "chemical names, specifications, dimensions, country of origin). Use noun phrases and " +
  "tariff vocabulary, not a question or a sentence. Output ONLY the rewritten description " +
  "— no preamble, no explanation, no quotes.";

/** Build the user prompt handed to the rewrite model. Pure — no network. */
export function buildRewritePrompt(query: string): string {
  return `Product description:\n${query.trim()}\n\nRewritten tariff-style description:`;
}

/**
 * Compose the retrieval query from the original and its rewrite per `strategy`.
 * Pure. `hyde` returns the rewrite alone; `expand` returns both joined (original
 * first, so its exact terms lead). An empty rewrite falls back to the original
 * under BOTH strategies — never retrieve on nothing.
 */
export function composeQuery(
  original: string,
  rewrite: string,
  strategy: RewriteStrategy,
): string {
  const r = rewrite.trim();
  if (!r) return original;
  if (strategy === "hyde") return r;
  return `${original.trim()}\n${r}`;
}

/**
 * Rewrite `query` into retrieval text per `strategy`, degrading to the original on
 * ANY failure. A blank query short-circuits to itself WITHOUT a billable call
 * (matching `denseRetrieve` / `rerankChunks`). The rewrite is trimmed and capped
 * at {@link MAX_REWRITE_CHARS}; an empty/whitespace rewrite is treated as a
 * failure (fires `onFallback`, keeps the original), so a degenerate response can
 * never retrieve on an empty query.
 */
export async function rewriteQuery(
  query: string,
  strategy: RewriteStrategy,
  deps: RewriteDeps,
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) return query;
  try {
    const raw = (await deps.rewrite(trimmed)).trim();
    if (!raw) {
      deps.onFallback?.();
      return query;
    }
    return composeQuery(trimmed, raw.slice(0, MAX_REWRITE_CHARS), strategy);
  } catch (err) {
    console.warn(
      `[rewrite] falling back to the original query: ${(err as Error).message}`,
    );
    deps.onFallback?.();
    return query;
  }
}

/**
 * Build the default rewrite transport: a single buffered `generateText` call
 * through the app gateway. `chatModel()` is resolved lazily at CALL time (not
 * import) so this module loads without credentials; a missing key throws here and
 * is caught by `rewriteQuery`, degrading to the original query.
 */
export function createLlmRewrite(): RewriteFn {
  return async (query) => {
    const { text } = await generateText({
      model: chatModel(),
      system: REWRITE_SYSTEM_PROMPT,
      prompt: buildRewritePrompt(query),
      abortSignal: AbortSignal.timeout(REWRITE_TIMEOUT_MS),
    });
    return text;
  };
}

/**
 * Wrap a retriever so the query is rewritten (per `mode`) before it hits the
 * underlying retrieval. `off` returns the retriever UNCHANGED (zero overhead — no
 * wrapper call, no billable rewrite), so the flag's default path is identical to
 * the un-rewritten baseline. Otherwise every call rewrites first, then retrieves.
 * `DenseRetriever`-compatible in and out, so it composes with the dense baseline
 * AND the `hybrid+rerank` arm and drops straight into `createConfiguredRetriever`.
 */
export function withQueryRewrite(
  retriever: DenseRetriever,
  mode: QueryRewriteMode,
  deps: RewriteDeps,
): DenseRetriever {
  if (mode === "off") return retriever;
  return async (query: string, opts: DenseRetrieveOptions = {}) => {
    const retrievalQuery = await rewriteQuery(query, mode, deps);
    return retriever(retrievalQuery, opts);
  };
}
