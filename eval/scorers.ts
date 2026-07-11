/**
 * U10 — deterministic end-to-end accuracy scoring + report rendering (Task 5/6).
 *
 * Two pure layers, no I/O, so the whole thing is unit-tested without a gateway or
 * DB (mirroring `retrieval-recall.ts`):
 *
 *  1. **Scoring** (`scoreClassification`, `summarizeAccuracy`). Given a finished
 *     classification and the row's gold code, did the agent get it right? Two
 *     framings the plan calls for: `top-1 exact` (the best-ranked candidate) and
 *     `top-3 recall` (any of the three), each at 10-, 6-, and 4-digit precision.
 *     Code comparison reuses `codeDigits`/`matchesAtDigits` from the recall
 *     harness so accuracy and recall@k judge an HTS match IDENTICALLY — the
 *     Task-6 lift can't be an artifact of two different matchers.
 *
 *  2. **Rendering** (`renderReport`). Turns the computed suites into `eval/report.md`
 *     with the headline baseline-vs-advanced comparison tables. Pure string work,
 *     so the report's shape (delta signs, percentages, the n=200 CI caveat) is
 *     pinned by tests, not eyeballed after a costly live run.
 *
 * The Execution note's discipline is baked into the layout: retrieval recall@k
 * leads (it isolates the retrieval change the LLM step can mask), end-to-end
 * accuracy follows with its confidence-interval caveat, and the LLM-judged RAG
 * metrics come last and clearly scoped to their subset.
 */
import { codeDigits, matchesAtDigits, type RecallResult } from "@/eval/retrieval-recall";
import type { RetrievalMode } from "@/lib/retrieval";
import type { ClassificationResult } from "@/lib/schema";

/** Digit levels the accuracy suite reports: full 10-digit, the 6-digit HS layer,
 *  and a 4-digit heading-prefix column (coarsest — "did we get the chapter right"). */
export const ACCURACY_DIGITS = [10, 6, 4] as const;

/** The two accuracy framings: the single best pick, and any-of-top-3. */
export type AccuracyMetric = "top1" | "top3";
export const ACCURACY_METRICS: readonly AccuracyMetric[] = ["top1", "top3"];

/** One scored classification: the gold code and the ranked candidate codes. */
export interface ClassificationOutcome {
  gold: string;
  /** Candidate HTS codes, best-first (`candidates[i].hts_code`). */
  rankedCodes: string[];
}

/**
 * Project a finished `ClassificationResult` to the codes we score. The schema
 * guarantees candidates are ranked best-first and length 3, so `rankedCodes[0]`
 * is the top-1 pick and the whole array is the top-3 set. We score the ranked
 * candidates (not `recommendation`) so top-1 and top-3 share one ranking — the
 * recommendation is the broker-facing defense of that same rank-1 choice.
 */
export function toOutcome(result: ClassificationResult, gold: string): ClassificationOutcome {
  return { gold, rankedCodes: result.candidates.map((c) => c.hts_code) };
}

/**
 * Did the outcome hit the gold code at `digits` precision, under `metric`?
 * `top1` checks only the rank-1 candidate; `top3` checks any candidate. A gold
 * code shorter than `digits` cannot be judged at that precision, so it counts as
 * a miss (same rule as the recall harness — `matchesAtDigits` enforces it).
 */
export function outcomeHit(
  outcome: ClassificationOutcome,
  metric: AccuracyMetric,
  digits: number,
): boolean {
  if (codeDigits(outcome.gold).length < digits) return false;
  const codes = metric === "top1" ? outcome.rankedCodes.slice(0, 1) : outcome.rankedCodes;
  return codes.some((code) => matchesAtDigits(code, outcome.gold, digits));
}

/** One aggregated accuracy cell: a (metric, digits) pair over the scored rows. */
export interface AccuracyResult {
  metric: AccuracyMetric;
  digits: number;
  hits: number;
  total: number;
  accuracy: number;
}

/** Compute accuracy for every (metric, digit-level) pair over the scored outcomes. */
export function summarizeAccuracy(
  outcomes: readonly ClassificationOutcome[],
  metrics: readonly AccuracyMetric[] = ACCURACY_METRICS,
  digitLevels: readonly number[] = ACCURACY_DIGITS,
): AccuracyResult[] {
  const results: AccuracyResult[] = [];
  for (const metric of metrics) {
    for (const digits of digitLevels) {
      const hits = outcomes.reduce((n, o) => n + (outcomeHit(o, metric, digits) ? 1 : 0), 0);
      results.push({
        metric,
        digits,
        hits,
        total: outcomes.length,
        accuracy: outcomes.length ? hits / outcomes.length : 0,
      });
    }
  }
  return results;
}

// ── Report rendering (pure) ────────────────────────────────────────────────────

/** The AE4 outcome the report records (shape mirrors `dataset.ts#LeakageReport`). */
export interface LeakageSummary {
  checked: number;
  threshold: number;
  violations: readonly { subject: string; testDescription: string; similarity: number }[];
}

/** Per-mode retrieval-recall suite result. */
export interface RecallSuite {
  mode: RetrievalMode;
  results: RecallResult[];
  scored: number;
  errors: number;
  /**
   * Advanced arm only: rows whose Cohere rerank degraded to fused-hybrid order
   * (rate-limit/outage/missing key). Undefined for the dense arm (never reranks).
   * A high value means the "hybrid+rerank" numbers actually measure fused-hybrid —
   * `renderReport` surfaces this so a degraded run can't masquerade as a real one.
   */
  rerankFallbacks?: number;
}

/** Per-mode end-to-end accuracy suite result. */
export interface AccuracySuite {
  mode: RetrievalMode;
  results: AccuracyResult[];
  scored: number;
  errors: number;
}

/** One LLM-judged RAG metric; `score` is null when the judge call errored. */
export interface RagScore {
  name: string;
  score: number | null;
}

/** Per-mode RAG-metrics suite result (computed on a subset). */
export interface RagSuite {
  mode: RetrievalMode;
  scores: RagScore[];
  scored: number;
}

/** Everything the report needs; `run.ts` assembles it, `renderReport` renders it. */
export interface ReportData {
  /** ISO timestamp, injected by the caller (scripts can't call `Date.now`). */
  generatedAt: string;
  datasetSize: number;
  /** Rows actually run through the end-to-end + RAG suites (may be sampled for cost). */
  e2eSampleSize: number;
  ragSampleSize: number;
  ks: number[];
  recallDigits: number[];
  accuracyDigits: number[];
  leakage: LeakageSummary;
  recall: RecallSuite[];
  accuracy: AccuracySuite[];
  rag: RagSuite[];
}

/** The advanced arm; `dense` is always the baseline the delta is measured from. */
const ADVANCED_MODE: RetrievalMode = "hybrid+rerank";

/**
 * Fraction of the advanced arm's rows that must have fallen back to fused-hybrid
 * order before the report flags the run as degraded. Mirrors the recall harness's
 * `MAX_ERROR_RATE` (0.1): a stray 1/200 fallback is noise, but once a MEANINGFUL
 * share of reranks never ran, the "hybrid+rerank" column is measuring fused-hybrid
 * and must say so. Fail-closed like AE4 — never present an unmeasured component
 * (the reranker) as measured.
 */
export const RERANK_FALLBACK_WARN_FRACTION = 0.1;

/**
 * A blockquote warning when the advanced arm's reranker silently degraded on a
 * meaningful fraction of rows, else `null` (dense arm, no data, or a clean run).
 * Rendered right under the recall table so the caveat is read BEFORE the headline
 * lift — the number below rests on fused-hybrid order, not reranked order.
 */
function rerankHealthNote(recall: readonly RecallSuite[]): string | null {
  const adv = suiteFor(recall, ADVANCED_MODE);
  if (!adv || adv.rerankFallbacks == null || adv.scored <= 0) return null;
  const n = adv.rerankFallbacks;
  if (n / adv.scored < RERANK_FALLBACK_WARN_FRACTION) return null;
  return (
    `> ⚠️ **Advanced arm degraded — the reranker did not run on ${n}/${adv.scored} rows.** ` +
    "Those reranks fell back to fused-hybrid (RRF) order because the Cohere rerank call failed " +
    "(rate-limit / outage / missing `COHERE_API_KEY`). For those rows the `hybrid+rerank` column " +
    "above measures **fused-hybrid, not reranked** retrieval — re-run with a healthy Cohere key " +
    "before trusting the advanced numbers or the headline lift."
  );
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

/** A signed percentage-point delta (advanced − baseline), or "—" when incomparable. */
function deltaPts(base: number | null, adv: number | null): string {
  if (base == null || adv == null) return "—";
  const d = (adv - base) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)} pts`;
}

/** Render a GitHub-flavoured markdown table from a header + string rows. */
function mdTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const sep = header.map(() => "---");
  return [header, sep, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/** Look up one mode's suite in a per-mode list. */
function suiteFor<T extends { mode: RetrievalMode }>(
  suites: readonly T[],
  mode: RetrievalMode,
): T | undefined {
  return suites.find((s) => s.mode === mode);
}

/**
 * Human note of how many rows each mode actually scored. Surfaces an ASYMMETRIC
 * denominator (one arm skipped more rows on error than the other) so a delta
 * computed over different row counts is visible rather than hidden behind a
 * single nominal sample size — the "lift is really the survivors" trap.
 */
function scopeNote(suites: readonly { mode: RetrievalMode; scored: number }[]): string {
  if (suites.length === 0) return "0 rows scored";
  const allEqual = suites.every((s) => s.scored === suites[0].scored);
  if (allEqual) return `${suites[0].scored} row(s) scored per mode`;
  return `rows scored per mode — ${suites.map((s) => `${s.mode}: ${s.scored}`).join(", ")}`;
}

/**
 * A baseline-vs-advanced comparison table: one row per `labels` entry, columns
 * for the baseline value, the advanced value, and the signed delta. `valueOf`
 * pulls the [0,1] score for a given (mode, rowIndex); returning null renders "—".
 */
function comparisonTable(
  rowHeader: string,
  labels: readonly string[],
  baseline: readonly (number | null)[] | null,
  advanced: readonly (number | null)[] | null,
): string {
  const rows = labels.map((label, i) => {
    const b = baseline?.[i] ?? null;
    const a = advanced?.[i] ?? null;
    return [
      label,
      b == null ? "—" : pct(b),
      a == null ? "—" : pct(a),
      deltaPts(b, a),
    ];
  });
  return mdTable([rowHeader, "dense (baseline)", "hybrid+rerank (advanced)", "Δ"], rows);
}

function recallRowLabels(ks: readonly number[], digits: readonly number[]): string[] {
  const labels: string[] = [];
  for (const d of digits) for (const k of ks) labels.push(`recall@${k} (≥${d}-digit)`);
  return labels;
}

function recallValues(suite: RecallSuite | undefined, ks: readonly number[], digits: readonly number[]): number[] | null {
  if (!suite) return null;
  const cell = (d: number, k: number) =>
    suite.results.find((r) => r.digits === d && r.k === k)?.recall ?? 0;
  const values: number[] = [];
  for (const d of digits) for (const k of ks) values.push(cell(d, k));
  return values;
}

function accuracyRowLabels(digits: readonly number[]): string[] {
  const labels: string[] = [];
  for (const metric of ACCURACY_METRICS) {
    for (const d of digits) {
      labels.push(`${metric === "top1" ? "top-1 exact" : "top-3 recall"} (≥${d}-digit)`);
    }
  }
  return labels;
}

function accuracyValues(suite: AccuracySuite | undefined, digits: readonly number[]): number[] | null {
  if (!suite) return null;
  const cell = (m: AccuracyMetric, d: number) =>
    suite.results.find((r) => r.metric === m && r.digits === d)?.accuracy ?? 0;
  const values: number[] = [];
  for (const metric of ACCURACY_METRICS) for (const d of digits) values.push(cell(metric, d));
  return values;
}

/** The Task-6 headline: the single largest recall@k gain, for the summary line. */
export function headlineRecallLift(data: ReportData): { label: string; delta: number } | null {
  const base = suiteFor(data.recall, "dense");
  const adv = suiteFor(data.recall, ADVANCED_MODE);
  if (!base || !adv) return null;
  let best: { label: string; delta: number } | null = null;
  for (const d of data.recallDigits) {
    for (const k of data.ks) {
      const b = base.results.find((r) => r.digits === d && r.k === k)?.recall;
      const a = adv.results.find((r) => r.digits === d && r.k === k)?.recall;
      if (b == null || a == null) continue;
      const delta = a - b;
      if (!best || delta > best.delta) best = { label: `recall@${k} at ≥${d}-digit`, delta };
    }
  }
  return best;
}

/**
 * Render the full `eval/report.md`. The section order encodes the Execution
 * note: recall@k first (the clean Task-6 signal), end-to-end accuracy second
 * with the ~±7% CI caveat for n=200, RAG metrics last and scoped to their subset.
 */
export function renderReport(data: ReportData): string {
  const lines: string[] = [];
  lines.push("# ClearClass — Evaluation Report (U10)");
  lines.push("");
  lines.push(
    `Generated ${data.generatedAt} over the ${data.datasetSize}-row flexifyai test split. ` +
      "Each suite is run in both retrieval modes — `dense` (the U5 baseline) and " +
      "`hybrid+rerank` (the U9 advanced arm) — against identical inputs, so the delta " +
      "columns isolate the Task-6 retrieval change.",
  );
  lines.push("");

  // AE4 — must come first: a failed leakage guard invalidates every number below.
  lines.push("## AE4 — leakage guard");
  lines.push("");
  if (data.leakage.violations.length === 0) {
    lines.push(
      `✅ **Clean.** ${data.leakage.checked} retrievable ruling(s) checked; none describe the ` +
        `same product as a test-split row above the ${data.leakage.threshold} similarity threshold. ` +
        "No test answer is readable back from the corpus.",
    );
  } else {
    lines.push(
      `❌ **LEAKAGE DETECTED** — ${data.leakage.violations.length} of ${data.leakage.checked} ` +
        "retrievable rulings collide with a test-split product. Scores below are INVALID until " +
        "the seed is re-filtered (U3) and the corpus re-ingested:",
    );
    lines.push("");
    lines.push(
      mdTable(
        ["ruling subject", "collides with test row", "similarity"],
        data.leakage.violations
          .slice(0, 10)
          .map((v) => [v.subject.slice(0, 80), v.testDescription.slice(0, 60), v.similarity.toFixed(3)]),
      ),
    );
  }
  lines.push("");

  // Suite 1 — retrieval recall@k (the headline).
  lines.push("## 1. Retrieval recall@k — the primary Task-6 signal");
  lines.push("");
  lines.push(
    "Fraction of test rows whose gold HTS code was surfaced in the top-k retrieved chunks, " +
      "with NO agent and NO LLM synthesis. This isolates the retrieval change: a real gain here " +
      "is the cleanest before/after evidence, because the LLM step downstream can mask it.",
  );
  lines.push("");
  lines.push(
    comparisonTable(
      "metric",
      recallRowLabels(data.ks, data.recallDigits),
      recallValues(suiteFor(data.recall, "dense"), data.ks, data.recallDigits),
      recallValues(suiteFor(data.recall, ADVANCED_MODE), data.ks, data.recallDigits),
    ),
  );
  lines.push("");
  const rerankNote = rerankHealthNote(data.recall);
  if (rerankNote) {
    lines.push(rerankNote);
    lines.push("");
  }
  const lift = headlineRecallLift(data);
  if (lift) {
    const cellCount = data.ks.length * data.recallDigits.length;
    lines.push(
      `**Headline:** hybrid+rerank moves ${lift.label} by ` +
        `${lift.delta >= 0 ? "+" : ""}${(lift.delta * 100).toFixed(1)} pts over the dense baseline ` +
        `(the largest of ${cellCount} recall@k cells — read the full table above, not this cell alone).`,
    );
    lines.push("");
  }

  // Suite 2 — end-to-end accuracy.
  lines.push("## 2. End-to-end classification accuracy");
  lines.push("");
  lines.push(
    `Deterministic exact-match scoring of the full agent loop (retrieve → reason → rank)` +
      `${data.accuracy.length ? ` — ${scopeNote(data.accuracy)}` : ""}. \`top-1 exact\` is the ` +
      "best-ranked candidate; `top-3 recall` is any of the three ranked candidates. A row the agent " +
      "declines (no defensible corpus-backed code) is scored as a MISS, not excluded.",
  );
  lines.push("");
  lines.push(
    data.accuracy.length
      ? comparisonTable(
          "metric",
          accuracyRowLabels(data.accuracyDigits),
          accuracyValues(suiteFor(data.accuracy, "dense"), data.accuracyDigits),
          accuracyValues(suiteFor(data.accuracy, ADVANCED_MODE), data.accuracyDigits),
        )
      : "_End-to-end suite not run in this pass._",
  );
  lines.push("");
  if (data.accuracy.length) {
    lines.push(
      `> **Confidence caveat:** at n=${data.e2eSampleSize}, a binomial 95% CI is roughly ±` +
        `${(196 / (2 * Math.sqrt(Math.max(1, data.e2eSampleSize)))).toFixed(0)}%. ` +
        "A small end-to-end delta may be within noise even when recall@k clearly improves — which is " +
        "why the Task-6 claim leads with recall@k above, not this table.",
    );
    lines.push("");
  }

  // Suite 3 — LLM-judged RAG metrics, scoped to a subset.
  lines.push("## 3. RAG quality metrics (autoevals, LLM-judged)");
  lines.push("");
  const ragForNames = data.rag.find((s) => s.scores.length > 0);
  lines.push(
    "Braintrust `autoevals` RAGAS-ported scorers" +
      `${ragForNames ? ` on ${scopeNote(data.rag)}` : ` on a ${data.ragSampleSize}-row subset`} ` +
      "(LLM-judged, so slower and noisier than the deterministic suites above — kept small and " +
      "separate by design; each metric averages only its non-null judgments).",
  );
  lines.push("");
  lines.push(
    "> **AnswerRelevancy note:** we keep autoevals' question generation but recompute the score as " +
      "the mean **raw** cosine between each generated question and the query. Stock `autoevals` runs that " +
      "cosine through `EmbeddingSimilarity`'s hardcoded 0.7 floor (`(cos − 0.7) / 0.3`, clamped), which " +
      "collapses genuinely-relevant question↔description pairs (~0.48 cosine) to 0 on every row — RAGAS " +
      "itself uses the unfloored cosine. See `eval/run.ts#answerRelevancy`.",
  );
  lines.push("");
  if (ragForNames) {
    const metricNames = ragForNames.scores.map((s) => s.name);
    const values = (suite: RagSuite | undefined): (number | null)[] | null =>
      suite ? metricNames.map((n) => suite.scores.find((s) => s.name === n)?.score ?? null) : null;
    lines.push(
      comparisonTable(
        "metric",
        metricNames,
        values(suiteFor(data.rag, "dense")),
        values(suiteFor(data.rag, ADVANCED_MODE)),
      ),
    );
  } else {
    lines.push("_RAG-metrics suite not run in this pass._");
  }
  lines.push("");

  return lines.join("\n") + "\n";
}
