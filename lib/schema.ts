/**
 * U6 — the structured classification contract (R4, R5, R6).
 *
 * This is the shape the agent must emit and the shape U8 renders. It is a pure
 * Zod module (no I/O, no imports beyond zod) so it can be validated exhaustively
 * in unit tests and reused unchanged by both the server agent loop and the
 * client UI.
 *
 * Two deliberate boundaries:
 *
 *  1. `sources_used` is NOT part of the model's output schema. Which sources the
 *     agent consulted is a *fact about tool execution*, not something to trust
 *     the model to self-report — it is derived server-side from the real tool
 *     results (`lib/agent.ts#deriveSourcesUsed`) and grafted onto the final
 *     `ClassificationResult`. A model that "says" it used only the corpus while
 *     having called web search cannot lie its way past this.
 *
 *  2. A corpus citation carries a `chunk_id` — the real `documents.id` the
 *     retrieve tool returned. The agent may cite ONLY ids it actually retrieved
 *     (KTD11); the enforcement lives in `validateCandidateCitations`, and this
 *     `chunk_id` field is the hook that makes that check possible. Web citations
 *     carry a `url` instead and can never introduce an HTS code.
 *
 * Nullable-not-optional: OpenAI-compatible structured output requires every
 * property to be present, using `null` for "absent" rather than omitting the
 * key. So the per-source citation fields are `.nullable()`, not `.optional()`.
 */
import { z } from "zod";

/** Where a citation came from: the grounded corpus, or live web search. */
export const citationSourceSchema = z.enum(["corpus", "web"]);
export type CitationSource = z.infer<typeof citationSourceSchema>;

/**
 * A single citation. A `corpus` citation must carry the `chunk_id` of a chunk
 * the retrieve tool returned (and typically the code/rule it encodes); a `web`
 * citation carries the `url` it came from. Fields not relevant to the source are
 * `null`. `validateCandidateCitations` later drops any corpus citation whose
 * `chunk_id` was not actually retrieved.
 */
export const citationSchema = z.object({
  source: citationSourceSchema,
  /** Real `documents.id` for a corpus citation; `null` for a web citation. */
  chunk_id: z.number().int().nullable(),
  /** HTS line code the cited chunk encodes (corpus), else null. */
  hts_code: z.string().nullable(),
  /** CBP CROSS ruling number the cited chunk encodes (corpus), else null. */
  ruling_number: z.string().nullable(),
  /** GRI rule identifier the cited chunk encodes (corpus), else null. */
  gri_rule: z.string().nullable(),
  /** Source URL for a web citation; `null` for a corpus citation. */
  url: z.string().nullable(),
  /** Human-readable title/snippet label for a web citation; else null. */
  title: z.string().nullable(),
});
export type Citation = z.infer<typeof citationSchema>;

/** One ranked candidate HTS code with its GRI reasoning, citations, confidence. */
export const candidateSchema = z.object({
  /** The candidate HTS code (10-digit where the corpus supports it). */
  hts_code: z.string().min(1),
  /** GRI-based reasoning for why this code fits (R5). */
  reasoning: z.string().min(1),
  /**
   * Citations backing the reasoning — corpus chunk ids and/or web urls (R5).
   * At least one is required: an uncited candidate is indefensible, which is the
   * opposite of this product's wedge. The agent additionally enforces at the
   * server that at least one *corpus* citation survives validation
   * (`lib/agent.ts#runClassification`) — a code backed only by untrusted web is
   * refused, not returned.
   */
  citations: z.array(citationSchema).min(1),
  /** Model confidence in [0, 1] (R5). */
  confidence: z.number().min(0).max(1),
});
export type Candidate = z.infer<typeof candidateSchema>;

/** The recommendation of one candidate over the others, with the rationale (R6). */
export const recommendationSchema = z.object({
  hts_code: z.string().min(1),
  why: z.string().min(1),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

/** Why a non-recommended candidate was not chosen — the broker's defense (R6). */
export const whyNotSchema = z.object({
  hts_code: z.string().min(1),
  why: z.string().min(1),
});
export type WhyNot = z.infer<typeof whyNotSchema>;

/**
 * The model's structured output: exactly three ranked candidates (R4), a single
 * recommendation (R6), and the why-not rationale for the other two (R6). Exactly
 * three is a hard contract, not a hint — a run that cannot produce three
 * defensible candidates should fail loudly, not silently return two.
 */
export const classificationSchema = z.object({
  candidates: z.array(candidateSchema).length(3),
  recommendation: recommendationSchema,
  // Exactly two: the recommendation covers one candidate; the why-not explains
  // the other two (R6). Symmetric with the exactly-three candidates contract, so
  // U8 always renders a complete defense rather than a partial one.
  why_not: z.array(whyNotSchema).length(2),
});
export type Classification = z.infer<typeof classificationSchema>;

/**
 * Which sources the agent actually consulted, derived server-side from the real
 * tool results (never from the model). `corpus_chunk_ids` and `web_urls` are the
 * concrete evidence set; `corpus`/`web` are the booleans U8 renders as the
 * "sources used" marker (AE1/AE2).
 */
export interface SourcesUsed {
  corpus: boolean;
  web: boolean;
  corpus_chunk_ids: number[];
  web_urls: string[];
}

/** The full server response: the validated classification plus derived sources. */
export interface ClassificationResult extends Classification {
  sources_used: SourcesUsed;
}
