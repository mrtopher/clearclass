/**
 * U8 — one citation, rendered by source (R5). A corpus citation shows the
 * authority it encodes (HTS line, CBP ruling, or GRI rule) plus its real chunk
 * id — the defensibility wedge: the broker can see exactly what grounds the code.
 * A web citation is an outbound link, visually distinguished because web content
 * is untrusted context (it can never be the sole basis for a code — see
 * `lib/agent.ts`).
 *
 * Presentational only (no hooks/browser APIs), so it renders in any context.
 */
import type { Citation } from "@/lib/schema";

export function CitationItem({ citation }: { citation: Citation }) {
  if (citation.source === "web") {
    // Only render an actual link for an http(s) URL. React does not sanitize
    // `href`, so a `javascript:`/`data:` URL would execute on click. The server
    // already drops any web citation whose URL wasn't returned by Tavily
    // (`lib/agent.ts#isValidWebCitation`), so this is defense-in-depth against a
    // future widening of the citation source — not a live hole today.
    const safeUrl =
      citation.url && /^https?:\/\//i.test(citation.url) ? citation.url : null;
    return (
      <li className="flex flex-col gap-0.5 text-sm">
        <span className="inline-flex w-fit items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Web
        </span>
        {safeUrl ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-blue-600 underline underline-offset-2 hover:text-blue-500 dark:text-blue-400"
          >
            {citation.title ?? safeUrl}
          </a>
        ) : (
          <span className="text-neutral-500">{citation.title ?? "Web source"}</span>
        )}
      </li>
    );
  }

  // Corpus citation: surface whichever authority fields the chunk carries.
  const authority = citation.hts_code
    ? `HTS ${citation.hts_code}`
    : citation.ruling_number
      ? `CBP ruling ${citation.ruling_number}`
      : citation.gri_rule
        ? citation.gri_rule
        : "Corpus chunk";

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
        Corpus
      </span>
      <span className="font-mono text-neutral-800 dark:text-neutral-200">
        {authority}
      </span>
      {citation.gri_rule && citation.hts_code ? (
        <span className="text-xs text-neutral-500">({citation.gri_rule})</span>
      ) : null}
      {citation.chunk_id != null ? (
        <span className="text-xs text-neutral-400">#{citation.chunk_id}</span>
      ) : null}
    </li>
  );
}
