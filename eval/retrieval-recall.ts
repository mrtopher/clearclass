/**
 * U5 — retrieval recall@k harness (offline, scripted).
 *
 * Runs the eval test-split product descriptions straight through the baseline
 * dense retriever (NO agent, NO LLM synthesis) and reports recall@k: for each
 * test row, was a corpus chunk carrying the row's gold HTS code retrieved in the
 * top-k? This is the earliest quantitative signal on the plan's single biggest
 * accuracy risk — HTS chunking (U2). A low baseline here means the chunking is
 * defective and must be re-ingested NOW, before U6+ are built on top of it (the
 * whole reason U5 runs this before the agent/UI/eval stack exists).
 *
 * It is deliberately NOT the Task-6 end-to-end eval (that is U10, which reuses
 * this recall metric as its cleanest before/after signal). Here we isolate
 * retrieval from the LLM so a chunking defect can't be masked by a model that
 * guesses the right code anyway.
 *
 * Usage:
 *   npm run eval:recall                       # full test split, k=5,10,20, 6- & 10-digit
 *   npx tsx eval/retrieval-recall.ts --limit=25          # sample the first 25 rows (fast smoke)
 *   npx tsx eval/retrieval-recall.ts --k=10 --digits=6   # custom k / granularity
 *
 * Credentials (server-only): NEXT_PUBLIC_INSFORGE_BASE_URL + the project API key
 * (INSFORGE_API_KEY, or .insforge/project.json), plus the LLM gateway key — same
 * as the U4 load. Talks to the `match_documents` RPC via the SDK-free retriever.
 *
 * Exit code: non-zero when recall is IMPLAUSIBLY LOW (a chunking-defect alarm),
 * so `npm run eval:recall` works as the Verification Contract gate for U5.
 */
import { pathToFileURL } from "node:url";

import { withRetry } from "@/lib/corpus-io";
import { createFetchSearch, type RetrievedChunk } from "@/lib/retrieval/dense";
import { resolveAdminConfig } from "@/lib/insforge-admin";
import { embedTexts } from "@/lib/llm";
import { DEFAULT_SPLIT, cleanQuery, loadTestRows, type TestRow } from "@/eval/dataset";

// Dataset loading and query normalization moved to `eval/dataset.ts` (shared with
// the U10 accuracy/RAG suites); re-exported here so existing callers and this
// module's tests keep importing them from `@/eval/retrieval-recall` unchanged.
export { DEFAULT_SPLIT, cleanQuery, type TestRow };

const DEFAULT_KS = [5, 10, 20];
const DEFAULT_DIGITS = [6, 10];

/**
 * Implausibly-low floor for the loudest signal (best k, 6-digit). ATLAS's
 * end-to-end 6-digit baseline is ~57.5%; retrieval sits UPSTREAM of the LLM and
 * only has to *surface* the right line, so a healthy dense baseline should clear
 * this comfortably. Falling below it is the "chunking is broken — re-ingest"
 * alarm the plan calls for, not a fine-grained quality bar.
 */
export const IMPLAUSIBLY_LOW_RECALL = 0.2;

/** Digits-only view of an HTS code, so `0101.21.00.10` and `0101210010` compare equal. */
export function codeDigits(code: string): string {
  return code.replace(/\D/g, "");
}

/**
 * The HTS codes a retrieved chunk can vouch for. HTS lines and rulings carry
 * `hts_code`; a ruling may also list several under `hts_codes`. GRI chunks carry
 * none (they are interpretive rules, not codes) and contribute nothing here.
 */
export function chunkCodes(chunk: RetrievedChunk): string[] {
  const m = chunk.metadata as { hts_code?: unknown; hts_codes?: unknown };
  const codes: string[] = [];
  if (typeof m.hts_code === "string" && m.hts_code) codes.push(m.hts_code);
  if (Array.isArray(m.hts_codes)) {
    for (const c of m.hts_codes) if (typeof c === "string" && c) codes.push(c);
  }
  return codes;
}

/** True when `retrieved` and `gold` agree on their first `digits` digits (both long enough). */
export function matchesAtDigits(retrieved: string, gold: string, digits: number): boolean {
  const r = codeDigits(retrieved);
  const g = codeDigits(gold);
  if (r.length < digits || g.length < digits) return false;
  return r.slice(0, digits) === g.slice(0, digits);
}

/**
 * Did the top-`k` retrieved chunks surface the gold code at `digits` precision?
 * `rankedCodes[i]` is the code list of the i-th-ranked chunk. A gold code shorter
 * than `digits` can't be judged at that precision, so it counts as a miss.
 */
export function rowHitAtK(
  rankedCodes: string[][],
  gold: string,
  k: number,
  digits: number,
): boolean {
  if (codeDigits(gold).length < digits) return false;
  const upto = Math.min(k, rankedCodes.length);
  for (let i = 0; i < upto; i++) {
    for (const code of rankedCodes[i]) {
      if (matchesAtDigits(code, gold, digits)) return true;
    }
  }
  return false;
}

/** One row's retrieval outcome: the gold code and the ranked chunk-code lists. */
export interface RowResult {
  gold: string;
  rankedCodes: string[][];
}

export interface RecallResult {
  k: number;
  digits: number;
  hits: number;
  total: number;
  recall: number;
}

/** Compute recall@k for every (k, digit-level) pair over the scored rows. */
export function summarizeRecall(
  rows: readonly RowResult[],
  ks: readonly number[],
  digitLevels: readonly number[],
): RecallResult[] {
  const results: RecallResult[] = [];
  for (const digits of digitLevels) {
    for (const k of ks) {
      const hits = rows.reduce((n, r) => n + (rowHitAtK(r.rankedCodes, r.gold, k, digits) ? 1 : 0), 0);
      results.push({ k, digits, hits, total: rows.length, recall: rows.length ? hits / rows.length : 0 });
    }
  }
  return results;
}

/**
 * The chunking-defect alarm: is the best-k, coarsest-digit recall below the
 * floor? Coarsest digits + largest k is the most forgiving cell, so if even that
 * is near zero, retrieval is not finding the right chapter at all.
 */
export function isImplausiblyLow(results: readonly RecallResult[]): boolean {
  if (results.length === 0) return true;
  const coarsest = Math.min(...results.map((r) => r.digits));
  const candidates = results.filter((r) => r.digits === coarsest);
  const best = Math.max(...candidates.map((r) => r.recall));
  return best < IMPLAUSIBLY_LOW_RECALL;
}

/** Render the recall grid as a fixed-width table (digits × k). */
export function formatRecallTable(results: readonly RecallResult[]): string {
  const ks = [...new Set(results.map((r) => r.k))].sort((a, b) => a - b);
  const digitLevels = [...new Set(results.map((r) => r.digits))].sort((a, b) => a - b);
  const cell = (d: number, k: number) =>
    results.find((r) => r.digits === d && r.k === k)?.recall ?? 0;

  const header = ["digits", ...ks.map((k) => `k=${k}`)];
  const lines = [header.join("\t")];
  for (const d of digitLevels) {
    lines.push([`${d}`, ...ks.map((k) => cell(d, k).toFixed(3))].join("\t"));
  }
  return lines.join("\n");
}

/** Run per-query search with an injected `searchOne`, returning scored rows and an error count. */
export interface ScoreOutcome {
  scored: RowResult[];
  errors: number;
}

/**
 * Score each row by running its pre-computed embedding through `searchOne`
 * (which encapsulates k and any retry). A per-row failure is caught, counted,
 * and skipped — one flaky request must not sink the whole baseline — while the
 * survivors are still scored. The caller decides what a tolerable error rate is
 * (see `MAX_ERROR_RATE` in `main`); this helper only reports the split so that
 * policy is testable without a network. `embeddings` is assumed 1:1 with `rows`
 * (guaranteed by `embedTexts`).
 */
export async function scoreRows(
  rows: readonly TestRow[],
  embeddings: readonly number[][],
  searchOne: (embedding: number[], index: number) => Promise<RetrievedChunk[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<ScoreOutcome> {
  const scored: RowResult[] = [];
  let errors = 0;
  for (let i = 0; i < rows.length; i++) {
    try {
      const chunks = await searchOne(embeddings[i], i);
      scored.push({ gold: rows[i].gold_hts, rankedCodes: chunks.map(chunkCodes) });
    } catch (err) {
      errors++;
      console.warn(`[eval:recall] row ${i + 1} search failed: ${(err as Error).message} — skipping.`);
    }
    onProgress?.(i + 1, rows.length);
  }
  return { scored, errors };
}

// ── CLI / IO shell ────────────────────────────────────────────────────────────

/**
 * Max fraction of rows allowed to fail before the gate refuses a verdict. A gate
 * that computed recall over whatever subset happened to succeed could print
 * "chunking looks sound" from a heavily-degraded run — so past this rate we abort
 * rather than report a baseline biased toward the lucky survivors.
 */
export const MAX_ERROR_RATE = 0.1;

export interface RecallArgs {
  split: string;
  ks: number[];
  digits: number[];
  limit: number | null;
}

function parseIntList(value: string, flag: string): number[] {
  const nums = value.split(",").map((s) => Number.parseInt(s.trim(), 10));
  if (nums.some((n) => Number.isNaN(n) || n < 1)) {
    throw new Error(`Invalid ${flag}: ${JSON.stringify(value)} (expected comma-separated positive integers)`);
  }
  return [...new Set(nums)].sort((a, b) => a - b);
}

export function parseArgs(argv: string[]): RecallArgs {
  let split = DEFAULT_SPLIT;
  let ks = DEFAULT_KS;
  let digits = DEFAULT_DIGITS;
  let limit: number | null = null;

  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "split" && value) {
      split = value;
    } else if (key === "k" && value) {
      ks = parseIntList(value, "--k");
    } else if (key === "digits" && value) {
      digits = parseIntList(value, "--digits");
    } else if (key === "limit" && value) {
      const n = Number.parseInt(value, 10);
      if (Number.isNaN(n) || n < 1) {
        throw new Error(`Invalid --limit: ${JSON.stringify(value)} (expected a positive integer)`);
      }
      limit = n;
    } else {
      throw new Error(
        `Unrecognized argument: ${JSON.stringify(arg)}. Supported: --split=<path> --k=<a,b> --digits=<a,b> --limit=<n>`,
      );
    }
  }
  return { split, ks, digits, limit };
}

async function main(): Promise<void> {
  const { split, ks, digits, limit } = parseArgs(process.argv.slice(2));
  const maxK = Math.max(...ks);

  const rows = await loadTestRows(split, limit);
  console.log(
    `[eval:recall] Scoring ${rows.length} test rows${limit ? ` (--limit=${limit})` : ""} ` +
      `at k=${ks.join(",")}, digits=${digits.join(",")} (baseline dense, no agent).`,
  );

  const cfg = resolveAdminConfig();
  const search = createFetchSearch(cfg);

  // Batch-embed all queries in one gateway pass (embedMany parallelizes) rather
  // than one round-trip per row, then run the top-maxK cosine search per query.
  console.log(`[eval:recall] Embedding ${rows.length} queries (question framing stripped)...`);
  const embeddings = await withRetry(
    () => embedTexts(rows.map((r) => cleanQuery(r.description))),
    `embed ${rows.length} queries`,
  );

  const { scored, errors } = await scoreRows(
    rows,
    embeddings,
    (embedding, i) => withRetry(() => search(embedding, { k: maxK }), `match row ${i + 1}`),
    (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`[eval:recall]   ${done}/${total} rows searched`);
    },
  );

  if (scored.length === 0) {
    throw new Error("[eval:recall] every row failed to search — cannot report recall.");
  }
  // Defend the exit-code contract: a run that lost more than MAX_ERROR_RATE of its
  // rows would compute recall over a biased surviving subset and could falsely
  // print "chunking looks sound". Refuse the verdict instead.
  if (errors / rows.length > MAX_ERROR_RATE) {
    throw new Error(
      `[eval:recall] ${errors}/${rows.length} rows failed to search ` +
        `(> ${Math.round(MAX_ERROR_RATE * 100)}%) — the baseline would be biased toward the ` +
        `surviving rows; aborting rather than reporting a misleading gate.`,
    );
  }

  const results = summarizeRecall(scored, ks, digits);
  console.log(
    `\n[eval:recall] recall@k over ${scored.length} scored rows` +
      (errors ? ` (${errors} row(s) skipped on error)` : "") +
      ` — fraction whose gold HTS code was retrieved:\n`,
  );
  console.log(formatRecallTable(results));

  if (isImplausiblyLow(results)) {
    console.error(
      `\n[eval:recall] ⚠ IMPLAUSIBLY LOW recall (best coarse-digit recall < ${IMPLAUSIBLY_LOW_RECALL}).\n` +
        "  This is the chunking-defect alarm: dense retrieval is not surfacing the\n" +
        "  right HTS lines. Re-inspect U2 chunking (ancestor path / hts_code metadata)\n" +
        "  and re-ingest BEFORE building U6+. See the U5 Execution note.",
    );
    process.exit(1);
  }
  console.log(
    `\n[eval:recall] Baseline recall reported and above the ${IMPLAUSIBLY_LOW_RECALL} floor — ` +
      "chunking looks sound; U6 may proceed. (U9 will measure the advanced-retriever lift against this baseline.)",
  );
}

const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
