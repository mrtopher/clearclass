/**
 * U10 — the evaluation harness entrypoint (`npm run eval`): Tasks 5 & 6.
 *
 * Runs three suites over the flexifyai 200-row test split, each in BOTH retrieval
 * modes (`dense` baseline / `hybrid+rerank` advanced) against identical inputs,
 * and emits `eval/report.md` with the baseline-vs-advanced comparison:
 *
 *   1. Retrieval recall@k — no agent, no LLM. The clean Task-6 before/after signal
 *      (the LLM step downstream can mask a real retrieval gain in the final code,
 *      so this leads). Reuses the U5 recall math (`summarizeRecall`).
 *   2. End-to-end classification accuracy — the full agent loop, scored
 *      deterministically (top-1 exact / top-3 recall at 10/6/4-digit). Runs the
 *      REAL model path via `runClassification` + `defaultGenerate`, but WITHOUT
 *      `createRunAgent`'s per-importer memory, so scoring never writes precedent
 *      rows into the live `classifications` table.
 *   3. RAG quality metrics — Braintrust `autoevals` LLM-as-judge scorers
 *      (Faithfulness, AnswerRelevancy, Context precision/recall) on a small subset,
 *      routed through the same OpenAI-compatible gateway as the app (KTD9).
 *
 * AE4 (`assertNoLeakage`) runs FIRST and aborts the whole run on any violation —
 * a leaked ruling would let the model read the answer key, invalidating every
 * number below it.
 *
 * SDK-free / offline (tsx), like the U5 recall harness: retrieval and the leakage
 * read go through the PostgREST proxy; the model + judges go through the gateway.
 * Cost-aware: the expensive suites (2 & 3) sample by default — the full 200-row
 * end-to-end run in both modes is ~400 agent loops, a deliberate budgeted step
 * (see `--e2e-limit` / `--rag-limit`).
 *
 * Usage:
 *   npm run eval                                  # recall(200) + e2e(sampled) + rag(sampled), both modes
 *   npx tsx eval/run.ts --recall-only             # just the cheap Task-6 headline signal
 *   npx tsx eval/run.ts --e2e-limit=200 --rag-limit=40   # the full budgeted run
 *   npx tsx eval/run.ts --modes=dense             # a single arm
 *   npx tsx eval/run.ts --modes=hybrid+rerank --e2e-limit=200 --skip-rag [--reselect]
 *                                                 # the Task-6.3 agent A/B: run once
 *                                                 # without and once WITH --reselect,
 *                                                 # retrieval mode held fixed.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AnswerRelevancy,
  ContextPrecision,
  ContextRecall,
  Faithfulness,
} from "autoevals";

import { withRetry } from "@/lib/corpus-io";
import { resolveAdminConfig } from "@/lib/insforge-admin";
import { DEFAULT_MODEL, embedTexts } from "@/lib/llm";
import {
  createConfiguredRetriever,
  RETRIEVAL_MODES,
  type RetrievalMode,
} from "@/lib/retrieval";
import { DEFAULT_K } from "@/lib/retrieval/dense";
import {
  defaultGenerate,
  IndefensibleClassificationError,
  resolveReselect,
  RETRIEVE_TOOL,
  runClassification,
  WEB_SEARCH_TOOL,
  type ClassificationDeps,
} from "@/lib/agent";
import { createRetrieveTool } from "@/lib/tools/retrieve";
import { createTavilyTool } from "@/lib/tools/tavily";
import type { ClassificationResult } from "@/lib/schema";
import {
  chunkCodes,
  MAX_ERROR_RATE,
  summarizeRecall,
  type RowResult,
} from "@/eval/retrieval-recall";
import {
  assertNoLeakage,
  cleanQuery,
  createFetchRulingSubjects,
  DEFAULT_SPLIT,
  loadTestRows,
  type TestRow,
} from "@/eval/dataset";
import {
  ACCURACY_DIGITS,
  renderReport,
  summarizeAccuracy,
  toOutcome,
  type AccuracySuite,
  type RagScore,
  type RagSuite,
  type RecallSuite,
  type ReportData,
} from "@/eval/scorers";

const DEFAULT_KS = [5, 10, 20];
const DEFAULT_RECALL_DIGITS = [6, 10];
/** End-to-end + RAG sample sizes: kept small by default because each row is a
 *  billable agent loop; the full run is opt-in (`--e2e-limit` / `--rag-limit`). */
const DEFAULT_E2E_LIMIT = 25;
const DEFAULT_RAG_LIMIT = 10;
/** Chunks pulled as RAG context for the LLM judges (what the retriever surfaces
 *  for the query — a faithful stand-in for the agent's grounding). */
const RAG_CONTEXT_K = DEFAULT_K;
const DEFAULT_OUT = "eval/report.md";
/**
 * RAG rows tolerate more failure than recall/e2e before aborting: the judges are
 * LLM calls on a small subset (flakier than a deterministic retrieval/agent run),
 * and RAG is the explicitly-secondary suite — so a few dropped rows warn and the
 * per-mode scored count is surfaced in the report rather than nuking a run whose
 * expensive recall + e2e suites already completed. (`MAX_ERROR_RATE`, the strict
 * 0.1 gate for the deterministic suites, is imported from the recall harness.)
 */
const RAG_MAX_ERROR_RATE = 0.5;
/**
 * Rows scored in parallel per suite. The run is latency-bound (each row is a
 * sequence of network round-trips), so overlapping rows cuts wall-clock ~Nx at
 * the SAME token cost. Kept modest by default: the e2e agent loop fans out to
 * several model+tool calls per row, so 6 concurrent rows is already a healthy
 * burst against the gateway / rerank / DB without tripping rate limits. Raise it
 * (`--concurrency`) on generous quotas; lower it to 1 for a strictly serial run.
 */
const DEFAULT_CONCURRENCY = 6;

// ── Suite 1: retrieval recall@k (mode-agnostic — works for dense AND hybrid) ────

/** One suite's per-row loop outcome. */
interface LoopOutcome<T> {
  scored: T[];
  errors: number;
}

/**
 * Run `task(i)` for every index in [0, total) with at most `concurrency` tasks
 * in flight, so a suite's independent per-row network work OVERLAPS instead of
 * running strictly serially. The rows never interact (each scores one query), so
 * this is pure wall-clock savings at the SAME token cost — the whole run is
 * latency-bound, not compute-bound. Each task owns its own try/catch, so one
 * failure never rejects the pool. Order-independent: callers aggregate the whole
 * result set (`summarizeRecall`/`summarizeAccuracy`/`averageRagScores`), so the
 * completion order of a concurrent run does not change any reported number.
 */
async function runPool(
  total: number,
  concurrency: number,
  task: (i: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < total; i = next++) {
      await task(i);
    }
  };
  const workers = Math.min(Math.max(1, concurrency), Math.max(1, total));
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * Score retrieval recall for one mode by calling its retriever with the query
 * STRING (not a pre-computed embedding), so the same loop drives both the dense
 * arm and the hybrid+rerank arm (which embeds + does lexical internally). A
 * per-row failure is caught, counted, and skipped — one flaky request must not
 * sink the arm's baseline. Mirrors `retrieval-recall.ts#scoreRows`, generalized
 * off the embedding assumption and run with bounded concurrency.
 *
 * The retriever is built HERE (not passed in) so the advanced arm's rerank-health
 * sink can be wired to a per-run counter: `rerankFallbacks` is how many rows saw
 * the Cohere rerank degrade to fused-hybrid order (rate-limit/outage/missing key).
 * It stays 0 for the dense arm (no rerank), and threads up into the `RecallSuite`
 * so `renderReport` can flag a degraded run instead of silently labelling
 * fused-hybrid numbers as "reranked". The shared counter is safe across the
 * concurrent rows — the event loop is single-threaded, so `n++` never races.
 */
async function scoreRetrieval(
  rows: readonly TestRow[],
  mode: RetrievalMode,
  maxK: number,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<LoopOutcome<RowResult> & { rerankFallbacks: number }> {
  const scored: RowResult[] = [];
  let errors = 0;
  let done = 0;
  let rerankFallbacks = 0;
  const retriever = createConfiguredRetriever(mode, {
    onRerankFallback: () => {
      rerankFallbacks++;
    },
  });
  await runPool(rows.length, concurrency, async (i) => {
    try {
      const chunks = await withRetry(
        () => retriever(cleanQuery(rows[i].description), { k: maxK }),
        `retrieve row ${i + 1}`,
      );
      scored.push({ gold: rows[i].gold_hts, rankedCodes: chunks.map(chunkCodes) });
    } catch (err) {
      errors++;
      console.warn(`[eval] recall row ${i + 1} failed: ${(err as Error).message} — skipping.`);
    }
    onProgress?.(++done, rows.length);
  });
  return { scored, errors, rerankFallbacks };
}

// ── Suite 2: end-to-end classification accuracy ────────────────────────────────

/** Build the agent deps for a mode: the retrieve tool bound to that mode's
 *  retriever, plus the real web-search tool and the real (buffered) model loop.
 *  No memory layer — the eval must not persist precedent into the live table.
 *  `reselect` toggles the Task-6.3 agent-side lever so the harness can A/B it with
 *  RETRIEVAL_MODE held fixed (isolating the agent change from the retriever). */
function classificationDepsFor(mode: RetrievalMode, reselect: boolean): ClassificationDeps {
  return {
    tools: {
      [RETRIEVE_TOOL]: createRetrieveTool(createConfiguredRetriever(mode)),
      [WEB_SEARCH_TOOL]: createTavilyTool(),
    },
    generate: defaultGenerate,
    reselect,
  };
}

/** Run the full agent loop over the rows for one mode, scoring each result's
 *  gold match. A per-row classification error (including the indefensible-code
 *  refusal) is recorded and skipped — not fatal to the run. */
async function scoreEndToEnd(
  rows: readonly TestRow[],
  mode: RetrievalMode,
  reselect: boolean,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<LoopOutcome<ReturnType<typeof toOutcome>>> {
  const deps = classificationDepsFor(mode, reselect);
  const scored: ReturnType<typeof toOutcome>[] = [];
  let errors = 0;
  let done = 0;
  await runPool(rows.length, concurrency, async (i) => {
    try {
      const result = await runClassification({ messages: cleanQuery(rows[i].description) }, deps);
      scored.push(toOutcome(result, rows[i].gold_hts));
    } catch (err) {
      if (err instanceof IndefensibleClassificationError) {
        // A refusal is a real product failure (no defensible answer), NOT a
        // transport error — score it as a zero-hit MISS so accuracy isn't inflated
        // by excluding declined rows, and both arms keep identical denominators.
        scored.push({ gold: rows[i].gold_hts, rankedCodes: [] });
      } else {
        errors++;
        console.warn(`[eval] e2e[${mode}] row ${i + 1} failed: ${(err as Error).message} — skipping.`);
      }
    }
    onProgress?.(++done, rows.length);
  });
  return { scored, errors };
}

// ── Suite 3: RAG quality metrics (LLM-judged, subset) ──────────────────────────

/**
 * The judge gateway config — the same OpenAI-compatible endpoint the app uses.
 * No `embeddingModel`: the only embedding step (AnswerRelevancy's question↔input
 * cosine) goes through `embedTexts`, which already uses the app's default model.
 */
interface JudgeConfig {
  model: string;
  openAiApiKey: string;
  openAiBaseUrl: string;
}

function resolveJudgeConfig(): JudgeConfig {
  const openAiApiKey = process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!openAiApiKey) {
    throw new Error(
      "[eval] RAG judges need an LLM key: set LLM_API_KEY or OPENROUTER_API_KEY " +
        "(run `npx @insforge/cli ai setup`). Or run with --skip-rag / --recall-only.",
    );
  }
  return {
    model: DEFAULT_MODEL,
    openAiApiKey,
    openAiBaseUrl: process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
  };
}

/** Compose the agent's answer into the single string the RAG judges grade. */
function answerText(result: ClassificationResult): string {
  const top = result.candidates[0];
  return (
    `Recommended HTS code: ${result.recommendation.hts_code}. ${result.recommendation.why} ` +
    (top ? top.reasoning : "")
  ).trim();
}

/** Run one judge, coercing any error (or a null score) into a `{name, score}`
 *  the report renders as "—" rather than aborting the subset. */
async function judge(
  name: string,
  run: () => { score: number | null } | Promise<{ score: number | null }>,
): Promise<RagScore> {
  try {
    const { score } = await run();
    return { name, score: typeof score === "number" ? score : null };
  } catch (err) {
    console.warn(`[eval] RAG judge ${name} failed: ${(err as Error).message}`);
    return { name, score: null };
  }
}

/** Cosine similarity of two equal-length embedding vectors; 0 for a zero vector. */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * AnswerRelevancy, but with the score computed correctly for THIS gateway.
 *
 * autoevals' `AnswerRelevancy` generates N questions from the answer and scores
 * how close they are to the real query — but it routes the closeness through
 * `EmbeddingSimilarity`, which rescales cosine by a hardcoded 0.7 floor
 * (`(cos − 0.7) / 0.3`, clamped to [0,1]) and gives `AnswerRelevancy` no way to
 * override it. A generated question ("What is the HTS code for …?") vs. a terse
 * product description sits around ~0.48 cosine here — genuinely relevant, but
 * below 0.7 → clamped to 0 on every row (both modes reported 0.0%). RAGAS itself
 * averages the RAW cosine, no floor. Embeddings route through the gateway fine
 * (verified); the floor is the whole defect.
 *
 * So we keep autoevals' question generation + noncommittal detection (its
 * `metadata.questions`) and recompute the score ourselves: mean raw cosine
 * between each generated question and the input, via the same proven gateway
 * embedder the retriever uses (`embedTexts`). A noncommittal answer still scores
 * 0 (RAGAS semantics). If question generation yields nothing (e.g. an autoevals
 * shape change), we return null so the report renders "—" rather than a fake 0.
 */
async function answerRelevancy(args: {
  input: string;
  output: string;
  context: string[];
  model: string;
  openAiApiKey: string;
  openAiBaseUrl: string;
}): Promise<{ score: number | null }> {
  const res = (await AnswerRelevancy({
    input: args.input,
    output: args.output,
    context: args.context,
    model: args.model,
    openAiApiKey: args.openAiApiKey,
    openAiBaseUrl: args.openAiBaseUrl,
  })) as { metadata?: { questions?: { question: string; noncommittal?: unknown }[] } };

  const questions = res.metadata?.questions ?? [];
  if (questions.length === 0) return { score: null };
  // RAGAS: an evasive/hedged ("noncommittal") answer scores 0 outright.
  if (questions.some((q) => q.noncommittal)) return { score: 0 };

  const [inputVec] = await embedTexts([args.input]);
  const questionVecs = await embedTexts(questions.map((q) => q.question));
  const sims = questionVecs.map((v) => Math.max(0, cosine(v, inputVec)));
  return { score: sims.reduce((a, b) => a + b, 0) / sims.length };
}

/** Judge one row: retrieve its context, run the agent, score the four RAG metrics. */
async function scoreRagRow(
  row: TestRow,
  mode: RetrievalMode,
  reselect: boolean,
  cfg: JudgeConfig,
): Promise<RagScore[]> {
  const query = cleanQuery(row.description);
  const auth = { model: cfg.model, openAiApiKey: cfg.openAiApiKey, openAiBaseUrl: cfg.openAiBaseUrl };
  const retriever = createConfiguredRetriever(mode);
  const chunks = await retriever(query, { k: RAG_CONTEXT_K });
  const context = chunks.map((c) => c.content);
  const result = await runClassification({ messages: query }, classificationDepsFor(mode, reselect));
  const output = answerText(result);
  const expected = row.reasoning;

  return Promise.all([
    judge("Faithfulness", () => Faithfulness({ input: query, output, context, ...auth })),
    judge("AnswerRelevancy", () => answerRelevancy({ input: query, output, context, ...auth })),
    judge("ContextPrecision", () => ContextPrecision({ input: query, output, context, expected, ...auth })),
    judge("ContextRecall", () => ContextRecall({ input: query, output, context, expected, ...auth })),
  ]);
}

/** Average each metric across the subset's rows, ignoring rows where a judge
 *  returned null (a failed/absent score should not drag the mean toward zero). */
function averageRagScores(perRow: readonly RagScore[][]): RagScore[] {
  if (perRow.length === 0) return [];
  const names = perRow[0].map((s) => s.name);
  return names.map((name) => {
    const values = perRow
      .flatMap((row) => row.filter((s) => s.name === name))
      .map((s) => s.score)
      .filter((v): v is number => typeof v === "number");
    return { name, score: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
  });
}

async function scoreRag(
  rows: readonly TestRow[],
  mode: RetrievalMode,
  reselect: boolean,
  cfg: JudgeConfig,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ scores: RagScore[]; scored: number; errors: number }> {
  const perRow: RagScore[][] = [];
  let errors = 0;
  let done = 0;
  await runPool(rows.length, concurrency, async (i) => {
    try {
      perRow.push(await scoreRagRow(rows[i], mode, reselect, cfg));
    } catch (err) {
      errors++;
      console.warn(`[eval] RAG[${mode}] row ${i + 1} failed: ${(err as Error).message} — skipping.`);
    }
    onProgress?.(++done, rows.length);
  });
  // Don't abort the whole run on RAG flakiness (unlike the strict deterministic
  // gate) — warn loudly instead. The report surfaces the actual per-mode `scored`
  // count so an average resting on only a few judgments is visible, not hidden.
  if (rows.length > 0 && errors / rows.length > RAG_MAX_ERROR_RATE) {
    console.warn(
      `[eval] RAG[${mode}] lost ${errors}/${rows.length} rows (> ${Math.round(RAG_MAX_ERROR_RATE * 100)}%); ` +
        "the metric averages below rest on few judgments — read the per-mode scored count in the report.",
    );
  }
  return { scores: averageRagScores(perRow), scored: perRow.length, errors };
}

// ── CLI ────────────────────────────────────────────────────────────────────────

interface EvalArgs {
  split: string;
  limit: number | null;
  e2eLimit: number | null;
  ragLimit: number | null;
  ks: number[];
  modes: RetrievalMode[];
  /** Task-6.3 agent-side lever: re-rank the model's own candidates by retrieval
   *  support (`--reselect` / `--reselect=off`). Held identical across both retrieval
   *  modes so a run isolates the agent change from the retriever. */
  reselect: boolean;
  recallOnly: boolean;
  skipE2e: boolean;
  skipRag: boolean;
  concurrency: number;
  out: string;
}

function parseModes(value: string): RetrievalMode[] {
  const parts = value.split(",").map((s) => s.trim().toLowerCase());
  const modes = parts.map((p) => {
    if (p === "dense" || p === "baseline") return "dense" as const;
    if (p === "hybrid+rerank" || p === "hybrid" || p === "advanced") return "hybrid+rerank" as const;
    throw new Error(`Invalid --modes value: ${JSON.stringify(p)} (expected dense | hybrid+rerank)`);
  });
  return [...new Set(modes)];
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new Error(`Invalid ${flag}: ${JSON.stringify(value)} (expected a positive integer)`);
  }
  return n;
}

export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = {
    split: DEFAULT_SPLIT,
    limit: null,
    e2eLimit: DEFAULT_E2E_LIMIT,
    ragLimit: DEFAULT_RAG_LIMIT,
    ks: DEFAULT_KS,
    modes: [...RETRIEVAL_MODES],
    reselect: false,
    recallOnly: false,
    skipE2e: false,
    skipRag: false,
    concurrency: DEFAULT_CONCURRENCY,
    out: DEFAULT_OUT,
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    switch (key) {
      case "split":
        if (value) args.split = value;
        break;
      case "limit":
        args.limit = parsePositiveInt(value, "--limit");
        break;
      case "e2e-limit":
        args.e2eLimit = parsePositiveInt(value, "--e2e-limit");
        break;
      case "rag-limit":
        args.ragLimit = parsePositiveInt(value, "--rag-limit");
        break;
      case "k":
        if (!value) throw new Error("--k requires a value, e.g. --k=5,10,20");
        args.ks = [
          ...new Set(value.split(",").map((s) => parsePositiveInt(s, "--k"))),
        ].sort((a, b) => a - b);
        break;
      case "modes":
        if (!value) throw new Error("--modes requires a value, e.g. --modes=dense,hybrid+rerank");
        args.modes = parseModes(value);
        break;
      case "reselect":
        // Bare `--reselect` turns it ON; `--reselect=off|on|true|false` is explicit.
        // resolveReselect only reads env when the value is undefined, so a defined
        // value (even "off") is honoured verbatim here.
        args.reselect = value == null ? true : resolveReselect(value);
        break;
      case "recall-only":
        args.recallOnly = true;
        break;
      case "skip-e2e":
        args.skipE2e = true;
        break;
      case "skip-rag":
        args.skipRag = true;
        break;
      case "concurrency":
        args.concurrency = parsePositiveInt(value, "--concurrency");
        break;
      case "out":
        if (value) args.out = value;
        break;
      default:
        throw new Error(
          `Unrecognized argument: ${JSON.stringify(arg)}. Supported: --split --limit ` +
            "--e2e-limit --rag-limit --k --modes --reselect --recall-only --skip-e2e --skip-rag --concurrency --out",
        );
    }
  }
  return args;
}

/** Abort if a suite lost more rows than the tolerance — a heavily-degraded run
 *  would report an aggregate biased toward the lucky survivors. */
function assertErrorRate(label: string, errors: number, total: number): void {
  if (total > 0 && errors / total > MAX_ERROR_RATE) {
    throw new Error(
      `[eval] ${label}: ${errors}/${total} rows failed (> ${Math.round(MAX_ERROR_RATE * 100)}%) — ` +
        "refusing to report a biased aggregate.",
    );
  }
}

function progress(label: string): (done: number, total: number) => void {
  return (done, total) => {
    if (done % 25 === 0 || done === total) console.log(`[eval]   ${label}: ${done}/${total}`);
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const maxK = Math.max(...args.ks);
  const rows = await loadTestRows(args.split, args.limit);
  console.log(
    `[eval] Loaded ${rows.length} test rows. Modes: ${args.modes.join(", ")}. ` +
      `Agent re-selection: ${args.reselect ? "ON" : "off"}. ` +
      `Suites: recall${args.recallOnly ? " only" : ", e2e, rag"}.`,
  );

  // AE4 FIRST — a leaked corpus invalidates every score below it.
  console.log("[eval] AE4: verifying no test-split ruling is retrievable from the corpus...");
  const cfg = resolveAdminConfig();
  const leakage = await assertNoLeakage(
    rows.map((r) => r.description),
    createFetchRulingSubjects(cfg),
  );
  if (leakage.violations.length > 0) {
    console.error(
      `[eval] ✗ AE4 FAILED: ${leakage.violations.length} retrievable ruling(s) collide with the ` +
        "test split. Re-filter the seed (U3) and re-ingest before scoring. First few:",
    );
    for (const v of leakage.violations.slice(0, 5)) {
      console.error(`  - "${v.subject.slice(0, 70)}" ~ "${v.testDescription.slice(0, 50)}" (${v.similarity.toFixed(3)})`);
    }
    process.exit(1);
  }
  console.log(`[eval] ✓ AE4 clean (${leakage.checked} rulings checked).`);

  const recall: RecallSuite[] = [];
  const accuracy: AccuracySuite[] = [];
  const rag: RagSuite[] = [];

  const e2eRows = args.e2eLimit ? rows.slice(0, args.e2eLimit) : rows;
  const ragRows = args.ragLimit ? rows.slice(0, args.ragLimit) : rows;
  const judgeCfg = !args.recallOnly && !args.skipRag ? resolveJudgeConfig() : null;

  console.log(`[eval] Scoring ${args.concurrency} rows in parallel per suite.`);

  for (const mode of args.modes) {
    console.log(`\n[eval] === mode: ${mode} ===`);

    // Suite 1: recall@k (all rows).
    console.log(`[eval] recall@k over ${rows.length} rows (k=${args.ks.join(",")})...`);
    const r = await scoreRetrieval(rows, mode, maxK, args.concurrency, progress("recall"));
    assertErrorRate(`recall[${mode}]`, r.errors, rows.length);
    recall.push({
      mode,
      results: summarizeRecall(r.scored, args.ks, DEFAULT_RECALL_DIGITS),
      scored: r.scored.length,
      errors: r.errors,
      rerankFallbacks: r.rerankFallbacks,
    });

    if (args.recallOnly) continue;

    // Suite 2: end-to-end accuracy (sampled).
    if (!args.skipE2e) {
      console.log(`[eval] end-to-end accuracy over ${e2eRows.length} rows (full agent loop)...`);
      const e = await scoreEndToEnd(e2eRows, mode, args.reselect, args.concurrency, progress("e2e"));
      assertErrorRate(`e2e[${mode}]`, e.errors, e2eRows.length);
      accuracy.push({
        mode,
        results: summarizeAccuracy(e.scored),
        scored: e.scored.length,
        errors: e.errors,
      });
    }

    // Suite 3: RAG metrics (sampled, LLM-judged).
    if (!args.skipRag && judgeCfg) {
      console.log(`[eval] RAG metrics over ${ragRows.length} rows (LLM-judged)...`);
      const g = await scoreRag(ragRows, mode, args.reselect, judgeCfg, args.concurrency, progress("rag"));
      rag.push({ mode, scores: g.scores, scored: g.scored });
    }
  }

  // Visibility for asymmetric denominators: if the two arms scored different row
  // counts, the accuracy delta spans non-identical inputs (the "lift is really the
  // survivors" trap). Refusals now count as misses, so this only fires on genuine
  // transport-error divergence — warn, and the report's per-mode scored note shows it.
  if (accuracy.length === 2 && accuracy[0].scored !== accuracy[1].scored) {
    console.warn(
      `[eval] e2e arms scored different row counts (${accuracy.map((a) => `${a.mode}:${a.scored}`).join(", ")}); ` +
        "the accuracy delta spans non-identical denominators.",
    );
  }

  const data: ReportData = {
    generatedAt: new Date().toISOString(),
    datasetSize: rows.length,
    // Attempted (sampled) counts — the CI's n and the section captions; the
    // per-mode `scored` inside each suite carries the actual denominators.
    e2eSampleSize: e2eRows.length,
    ragSampleSize: ragRows.length,
    ks: args.ks,
    recallDigits: DEFAULT_RECALL_DIGITS,
    accuracyDigits: accuracy.length ? [...ACCURACY_DIGITS] : [],
    reselect: args.reselect,
    leakage,
    recall,
    accuracy,
    rag,
  };

  const md = renderReport(data);
  const outPath = resolve(process.cwd(), args.out);
  await writeFile(outPath, md, "utf8");
  console.log(`\n[eval] Wrote ${args.out}. Task-6 headline is the recall@k table.`);
}

const isEntrypoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
