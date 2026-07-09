/**
 * U5 — the corpus-retrieval tool the agent calls (consumed by U6's loop).
 *
 * Wraps the baseline dense retriever (`lib/retrieval/dense.ts`) as a Vercel AI
 * SDK tool with a typed input schema, and projects each retrieved chunk down to
 * a citation-ready shape the agent can render: the source text, its similarity,
 * and whichever citation key its corpus type carries (an HTS line's `hts_code`,
 * a CBP ruling's `ruling_number`, or a GRI rule). Constraining citations to real
 * retrieved chunk ids is what lets U6 forbid the model from fabricating a code
 * (KTD11) — the agent may only cite what this tool actually returned.
 */
import { tool } from "ai";
import { z } from "zod";

import { createDenseRetriever, type DenseRetriever, type RetrievedChunk } from "@/lib/retrieval/dense";

/** The citation-ready projection of a retrieved chunk the agent renders. */
export interface Citation {
  /** The real `documents.id` — the agent may only cite ids this tool returned. */
  id: number;
  type: string;
  content: string;
  similarity: number;
  /** HTS line code (hts/ruling chunks). */
  hts_code?: string;
  /** CBP CROSS ruling number (ruling chunks). */
  ruling_number?: string;
  /** GRI rule identifier (gri chunks). */
  gri_rule?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Project a retrieved chunk to the citation fields the agent surfaces per type. */
export function toCitation(chunk: RetrievedChunk): Citation {
  const m = chunk.metadata;
  return {
    id: chunk.id,
    type: chunk.type,
    content: chunk.content,
    similarity: chunk.similarity,
    hts_code: str(m.hts_code),
    ruling_number: str(m.ruling_number),
    gri_rule: str(m.rule),
  };
}

export const retrieveInputSchema = z.object({
  query: z
    .string()
    .describe(
      "A product description or the key distinguishing attributes (material, use, form) to search the HTS/GRI/CBP-rulings corpus for.",
    ),
  k: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe("How many chunks to return (default 8). Ask for more only when disambiguating close headings."),
  type: z
    .enum(["hts", "gri", "ruling"])
    .optional()
    .describe("Restrict to one corpus source: 'hts' tariff lines, 'gri' interpretive rules, or 'ruling' CBP precedent. Omit to search all."),
});

export type RetrieveInput = z.infer<typeof retrieveInputSchema>;

/** The tool's structured result: the citations plus a count for the model to reason over. */
export interface RetrieveResult {
  count: number;
  chunks: Citation[];
}

/**
 * Build the retrieve tool bound to a dense retriever. The retriever defaults to
 * the live gateway + RPC transport but is injectable so U6's route and tests can
 * supply their own. Kept as a factory (not a bare singleton that resolves admin
 * config at import) so importing this module never requires credentials.
 */
export function createRetrieveTool(retriever: DenseRetriever = createDenseRetriever()) {
  return tool({
    description:
      "Search the grounded corpus (US HTS tariff lines, the General Rules of Interpretation, and seeded CBP CROSS rulings) for chunks relevant to a product. Returns ranked, citable chunks; cite classifications ONLY to the chunk ids this returns.",
    inputSchema: retrieveInputSchema,
    execute: async ({ query, k, type }: RetrieveInput): Promise<RetrieveResult> => {
      const chunks = await retriever(query, { k, type });
      return { count: chunks.length, chunks: chunks.map(toCitation) };
    },
  });
}
