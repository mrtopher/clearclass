/**
 * U8 — the pure presentation layer for the classification result (R4, R5).
 *
 * The chat UI is a thin React shell over a buffered JSON response (U6 returns a
 * validated `ClassificationResult`, NOT a `useChat` stream — see `lib/agent.ts`).
 * The genuinely branchy parts of rendering that response — matching each ranked
 * candidate to its recommendation/why-not rationale, describing which sources the
 * agent used (AE1/AE2), and turning an HTTP failure into a broker-facing message
 * — live here as pure functions so they can be unit-tested under the repo's
 * `node` Vitest env (no jsdom/RTL is configured; the plan scopes U8 to build +
 * deploy smoke, not component tests). The React components stay declarative.
 */
import type {
  Candidate,
  ClassificationResult,
  SourcesUsed,
} from "@/lib/schema";

/**
 * A candidate enriched with its role in the final defense: the single
 * recommended code carries the recommendation rationale; each of the other two
 * carries its why-not rationale (R6). `rank` is 1-based in the model's ranked
 * order. Association is by `hts_code` because that is the only key the
 * recommendation/why-not entries share with the candidates (the schema relates
 * them by code, not index).
 */
export interface CandidateView extends Candidate {
  rank: number;
  isRecommended: boolean;
  /** The recommendation `why` (recommended) or the why-not `why` (others).
   *  `null` only in the defensive case where the model related an entry to a
   *  code that is not among the candidates — rendered without a rationale rather
   *  than crashing. */
  rationale: string | null;
}

/**
 * Zip the flat `ClassificationResult` into per-candidate view models, preserving
 * the model's ranked order. The recommended candidate is the one whose
 * `hts_code` matches `recommendation.hts_code`; the rest are matched against the
 * `why_not` entries by code. A candidate with no matching rationale gets `null`
 * (defensive — the server contract guarantees a complete set, but the UI must
 * not throw if that ever slips).
 */
export function toCandidateViews(result: ClassificationResult): CandidateView[] {
  const whyNotByCode = new Map(
    result.why_not.map((entry) => [entry.hts_code, entry.why]),
  );
  return result.candidates.map((candidate, index) => {
    const isRecommended = candidate.hts_code === result.recommendation.hts_code;
    const rationale = isRecommended
      ? result.recommendation.why
      : whyNotByCode.get(candidate.hts_code) ?? null;
    return { ...candidate, rank: index + 1, isRecommended, rationale };
  });
}

/** Confidence in [0,1] → a whole-percent label (e.g. 0.872 → "87%"). */
export function formatConfidence(confidence: number): string {
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * The "sources used" marker (AE1 vs AE2), derived server-side and never from the
 * model. This mirrors the plan's acceptance examples: a well-covered product is
 * grounded in the corpus alone (AE1); a recent-trade-action product also shows a
 * live web source (AE2).
 */
export function describeSources(sources: SourcesUsed): string {
  if (sources.corpus && sources.web) return "Grounded corpus + live web search";
  if (sources.corpus) return "Grounded corpus only";
  if (sources.web) return "Live web search only";
  return "No sources recorded";
}

/**
 * Map a non-OK `/api/chat` response to a broker-facing message. The status codes
 * are the exact contract the server emits: 401 (gate, unauthenticated), 403
 * (gate, importer not permitted), 429 (middleware rate limit), 400 (bad input,
 * `lib/agent.ts` BadInputError), 502 (degraded synthesis). `detail`/`message`
 * from the body are surfaced only for the caller-fault 400 (its own input), never
 * for the 5xx path (which must not leak internals — see `createRunAgent`).
 */
export interface ChatErrorBody {
  error?: string;
  detail?: string;
  message?: string;
}

export function chatErrorMessage(status: number, body?: ChatErrorBody): string {
  switch (status) {
    case 400:
      return body?.detail
        ? `That request couldn't be processed: ${body.detail}`
        : "That request couldn't be processed. Please rephrase the product description.";
    case 401:
      return "Your session has expired. Please sign in again.";
    case 403:
      return "You're not authorized to classify for this importer.";
    case 429:
      return body?.message ?? "Too many requests. Please slow down and try again.";
    case 502:
      return "Classification is temporarily unavailable. Please try again in a moment.";
    default:
      return "Something went wrong. Please try again.";
  }
}
