/**
 * U8 — one ranked candidate HTS code as a card (R4, R5, R6): the code, its
 * confidence, GRI reasoning, the recommend/why-not rationale, and its citations
 * (expandable so long reasoning + many citations stay readable on a 375px phone
 * — the U8 edge scenario). The recommended candidate is visually promoted.
 *
 * Presentational only; consumes the `CandidateView` produced by
 * `lib/classification-view.ts` so no association logic lives in the view.
 */
import { CitationItem } from "@/components/Citation";
import { formatConfidence, type CandidateView } from "@/lib/classification-view";

export function CandidateCard({ candidate }: { candidate: CandidateView }) {
  const confidencePct = formatConfidence(candidate.confidence);
  return (
    <article
      className={
        "rounded-xl border p-4 " +
        (candidate.isRecommended
          ? "border-emerald-400 bg-emerald-50/50 dark:border-emerald-700 dark:bg-emerald-950/30"
          : "border-neutral-200 dark:border-neutral-800")
      }
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-neutral-400">
            #{candidate.rank}
          </span>
          <h3 className="font-mono text-lg font-semibold tracking-tight">
            {candidate.hts_code}
          </h3>
          {candidate.isRecommended ? (
            <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white">
              Recommended
            </span>
          ) : null}
        </div>
        <div className="flex flex-col items-end">
          <span className="text-sm font-medium tabular-nums">{confidencePct}</span>
          <div
            className="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
            role="img"
            aria-label={`Confidence ${confidencePct}`}
          >
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: confidencePct }}
            />
          </div>
        </div>
      </header>

      <p className="mt-3 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        {candidate.reasoning}
      </p>

      {candidate.rationale ? (
        <p
          className={
            "mt-2 rounded-lg px-3 py-2 text-sm " +
            (candidate.isRecommended
              ? "bg-emerald-100/70 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
              : "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400")
          }
        >
          <span className="font-medium">
            {candidate.isRecommended ? "Why recommended: " : "Why not: "}
          </span>
          {candidate.rationale}
        </p>
      ) : null}

      <details className="mt-3 group">
        <summary className="cursor-pointer list-none text-xs font-medium uppercase tracking-wide text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300">
          <span className="group-open:hidden">Show citations ({candidate.citations.length})</span>
          <span className="hidden group-open:inline">Hide citations</span>
        </summary>
        <ul className="mt-2 space-y-1.5 border-l-2 border-neutral-200 pl-3 dark:border-neutral-800">
          {candidate.citations.map((citation, i) => (
            <CitationItem key={i} citation={citation} />
          ))}
        </ul>
      </details>
    </article>
  );
}
