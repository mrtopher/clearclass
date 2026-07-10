/**
 * U9 — the rerank stage: a Cohere Rerank cross-encoder that reorders the fused
 * hybrid candidate pool (`lib/retrieval/hybrid.ts`) into the final top-k the agent
 * reasons over.
 *
 * A bi-encoder (dense embeddings) scores query and document independently; a
 * cross-encoder scores the PAIR jointly, so it resolves fine distinctions the
 * fused order gets wrong — the whole reason "advanced" retrieval should beat the
 * dense baseline on a query where an exact attribute ("of cotton") decides the
 * subheading.
 *
 * Sibling to `lib/tools/tavily.ts` in shape and in its ONE load-bearing contract:
 *
 *  - **Graceful degradation (edge scenario).** A Cohere outage — or a missing
 *    `COHERE_API_KEY` — must NOT crash retrieval. `rerankChunks` catches
 *    everything and returns the FUSED-HYBRID order truncated to top-k, so the
 *    advanced retriever still returns sensible results and the eval/agent path
 *    continues. This is the plan's "reranker API failure falls back to
 *    fused-hybrid order without crashing".
 *
 * SERVER-ONLY: reads `COHERE_API_KEY` (no NEXT_PUBLIC_ prefix). Import only from
 * server code / offline scripts. The pure orchestration (`rerankChunks`) is
 * dependency-injected over a `RerankFn`, so it unit-tests with fakes — no network.
 */
import type { RetrievedChunk } from "@/lib/retrieval/dense";

/** One reranked position: the index INTO the input document list, plus its score. */
export interface RerankResult {
  index: number;
  relevanceScore: number;
}

/** Rerank `documents` against `query`, returning positions best-first. Injectable for tests. */
export type RerankFn = (
  query: string,
  documents: string[],
  opts: { topN: number },
) => Promise<RerankResult[]>;

export interface RerankDeps {
  rerank: RerankFn;
}

const COHERE_ENDPOINT = "https://api.cohere.com/v2/rerank";

/** Hard wall-clock bound on a single rerank call. A hung upstream must not stall
 *  the billable classification — the timeout surfaces as an AbortError that
 *  `rerankChunks` turns into graceful fused-order degradation. */
export const COHERE_TIMEOUT_MS = 10_000;

/** Cohere rerank model. `rerank-v3.5` is the current general model; override via
 *  env if a cheaper/English-only model is preferred. */
export const DEFAULT_RERANK_MODEL = process.env.COHERE_RERANK_MODEL ?? "rerank-v3.5";

/** Parse Cohere's `{ results: [{ index, relevance_score }] }` into `RerankResult[]`,
 *  dropping any row without a numeric index (a malformed row must not shift the
 *  mapping back onto the wrong chunk). */
function coerceRerankResults(body: unknown): RerankResult[] {
  const rows = (body as { results?: unknown })?.results;
  if (!Array.isArray(rows)) return [];
  const out: RerankResult[] = [];
  for (const r of rows) {
    const row = r as { index?: unknown; relevance_score?: unknown };
    if (typeof row.index === "number") {
      out.push({
        index: row.index,
        relevanceScore:
          typeof row.relevance_score === "number" ? row.relevance_score : 0,
      });
    }
  }
  return out;
}

/**
 * Build the default Cohere Rerank transport. Key resolution is deferred to the
 * call (not import) so this module loads without credentials; a missing key
 * throws here and is caught by `rerankChunks`, degrading to fused-hybrid order.
 */
export function createCohereRerank(): RerankFn {
  return async (query, documents, { topN }) => {
    const apiKey = process.env.COHERE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "COHERE_API_KEY not configured (server-only). Rerank is disabled; " +
          "retrieval will fall back to fused-hybrid order.",
      );
    }
    const res = await fetch(COHERE_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_RERANK_MODEL,
        query,
        documents,
        top_n: topN,
      }),
      signal: AbortSignal.timeout(COHERE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `[rerank] Cohere HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
      );
    }
    return coerceRerankResults(await res.json());
  };
}

/**
 * Rerank the fused candidate `chunks` against `query` and return the top-`topN`.
 * On ANY rerank failure (outage, missing key, timeout, malformed response) this
 * falls back to the incoming fused order truncated to `topN` — retrieval degrades,
 * never crashes. An empty pool returns `[]`; a blank query keeps the fused order
 * (nothing to rank against). Out-of-range indices from the API are skipped so a
 * bad response can never fabricate or duplicate a chunk.
 */
export async function rerankChunks(
  query: string,
  chunks: readonly RetrievedChunk[],
  topN: number,
  deps: RerankDeps,
): Promise<RetrievedChunk[]> {
  const n = Math.max(1, Math.floor(topN));
  if (chunks.length === 0) return [];
  const trimmed = query.trim();
  if (!trimmed) return chunks.slice(0, n);
  try {
    const ranked = await deps.rerank(trimmed, [...chunks.map((c) => c.content)], {
      topN: n,
    });
    const reordered: RetrievedChunk[] = [];
    for (const r of ranked) {
      const chunk = chunks[r.index];
      if (chunk) reordered.push(chunk);
    }
    // A response that mapped to nothing usable is as good as a failure — keep the
    // fused order rather than return an empty (or partial-garbage) result.
    return reordered.length > 0 ? reordered.slice(0, n) : chunks.slice(0, n);
  } catch (err) {
    console.warn(
      `[rerank] falling back to fused-hybrid order: ${(err as Error).message}`,
    );
    return chunks.slice(0, n);
  }
}
