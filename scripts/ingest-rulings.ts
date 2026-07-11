/**
 * U3 — CBP CROSS rulings ingestion (offline, scripted), leakage-excluded.
 *
 * Seeds ~300 real CBP CROSS rulings as citable precedent chunks for U4, with
 * the leakage guard (R2, AE4) applied so no ruling describing the same product
 * as an eval test-split row can reach retrieval. The pure normalization and
 * leakage logic live in `lib/rulings.ts` (unit-tested); this script owns the
 * network I/O and persistence — the same split as `ingest-hts.ts`. Shared
 * fetch-with-retry and atomic-write helpers come from `lib/corpus-io.ts`.
 *
 * Data sources (both verified live 2026-07-08):
 *   - CBP CROSS API: https://rulings.cbp.gov/api/search (needs a search term).
 *   - Eval test split: the public flexifyai mirror on HuggingFace, cached to
 *     data/eval-test-split.jsonl and reused by U10.
 *
 * Usage:
 *   npm run ingest:rulings                      # -> data/ruling-chunks.jsonl
 *   npx tsx scripts/ingest-rulings.ts --out=/tmp/r.jsonl --target=200
 *
 * Loud-failure contract:
 *   - Refuses to write unless the eval test split is present, non-empty, and
 *     every cached row carries a description + gold code — the leakage guard is
 *     meaningless without real test descriptions, so a missing/corrupt split is
 *     a hard stop, never a silent unguarded corpus (protects AE4).
 *   - A single CROSS term failing after retries is warned and skipped, so a
 *     total CROSS outage degrades to zero rulings and triggers the fallback
 *     rather than crashing before the fallback can run.
 *   - A full run (real OR fallback) below the ruling floor throws (truncated fetch).
 *   - Atomic write (temp + rename) so an interrupted run can't clobber a good corpus.
 *   - If the CROSS API yields nothing, falls back to non-test flexifyai rows
 *     and flags the degraded provenance loudly (plan risk: weaker wedge).
 */
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { fetchWithRetry, writeJsonlAtomic } from "@/lib/corpus-io";
import {
  buildLeakageIndex,
  excludeLeakage,
  parseDatasetRow,
  roundRobinDedupe,
  toFallbackChunk,
  toRulingChunk,
  type DatasetRow,
  type ParsedDatasetRow,
  type RawCrossRuling,
  type RulingChunk,
} from "@/lib/rulings";

const CROSS_SEARCH = "https://rulings.cbp.gov/api/search";
const MIRROR_BASE =
  "https://huggingface.co/datasets/Dayanand314Krishna/cross_rulings_hts_dataset_for_tariffs/resolve/main";

const DEFAULT_OUT = "data/ruling-chunks.jsonl";
const TEST_SPLIT_PATH = "data/eval-test-split.jsonl";
/** Seed target after leakage filtering (broadened from the original ~300 to
 * lift retrieval recall — the eval's dominant top-1 loss is "code never
 * retrieved", so more precedent is the highest lever; see SUBMISSION.md Task 7). */
const DEFAULT_TARGET = 2000;
/** Hard floor for a full run — below this the fetch clearly failed/truncated. */
const MIN_RULINGS = 120;
const PAGE_SIZE = 40;
const MAX_PAGES_PER_TERM = 4;
const POLITE_DELAY_MS = 250;

/**
 * Broad product-category terms spanning many HTS chapters. CROSS `search`
 * requires a term (a blank term returns nothing), so we sample across
 * categories to build a diverse precedent seed rather than over-indexing on one
 * product family.
 */
const SEED_TERMS = [
  "cotton shirt", "knit apparel", "footwear", "leather handbag", "steel fitting",
  "aluminum", "plastic article", "machine part", "electric motor", "pump",
  "valve", "semiconductor", "battery", "lamp", "wooden furniture", "glassware",
  "ceramic", "toy", "jewelry", "rubber", "paper", "textile fabric", "hat",
  "gloves", "chemical", "food preparation", "beverage", "cosmetic", "fastener",
  "hand tool", "bicycle", "vehicle part",
  // Broadened coverage: terms spanning HTS chapters the original 32 missed, so
  // the precedent seed reaches product families beyond the initial sample.
  "optical instrument", "medical device", "watch", "clock", "musical instrument",
  "pharmaceutical", "coffee", "tea", "frozen fish", "prepared meat", "sauce",
  "printed book", "carpet", "umbrella", "camera", "copper wire", "steel tube",
  "stone article", "sporting goods", "aircraft part", "ship", "brush",
  "mattress", "sunglasses",
];

export interface RulingsArgs {
  out: string;
  target: number;
}

export function parseArgs(argv: string[]): RulingsArgs {
  let out = DEFAULT_OUT;
  let target = DEFAULT_TARGET;
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "out" && value) {
      out = value;
    } else if (key === "target" && value) {
      const n = Number.parseInt(value, 10);
      if (Number.isNaN(n) || n <= 0) {
        throw new Error(`Invalid --target: ${JSON.stringify(value)} (expected a positive integer)`);
      }
      target = n;
    } else {
      throw new Error(
        `Unrecognized argument: ${JSON.stringify(arg)}. Supported: --out=<path> --target=<n>`,
      );
    }
  }
  return { out, target };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch the mirror's JSONL splits (each line is a chat-format DatasetRow). */
function fetchJsonl(url: string, label: string): Promise<DatasetRow[]> {
  return fetchWithRetry(url, label, async (res) => {
    const text = await res.text();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as DatasetRow);
  });
}

/** A cached eval row is only usable if it carries both a description and a gold code. */
function isUsableTestRow(r: ParsedDatasetRow): boolean {
  return Boolean(r?.description?.trim()) && Boolean(r?.gold_hts?.trim());
}

/**
 * Ensure the eval test split is cached locally, returning its parsed rows.
 * Fetches from the mirror on a cache miss OR a corrupt cache. The leakage guard
 * cannot run without real test descriptions, so an empty/malformed cache (which
 * would silently disable the guard — every similarity would score 0) is treated
 * as a miss and re-fetched, never trusted.
 */
async function ensureTestSplit(): Promise<ParsedDatasetRow[]> {
  const cachePath = resolve(process.cwd(), TEST_SPLIT_PATH);
  try {
    await access(cachePath);
    const text = await readFile(cachePath, "utf8");
    const rows = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as ParsedDatasetRow);
    // Reject a cache that is empty or has ANY row missing a description/code —
    // a partially-corrupt split would guard some rows and silently skip others.
    if (rows.length === 0 || !rows.every(isUsableTestRow)) {
      throw new Error(`cached test split at ${TEST_SPLIT_PATH} is empty or malformed`);
    }
    console.log(`[ingest-rulings] Loaded ${rows.length} cached eval test-split rows from ${TEST_SPLIT_PATH}`);
    return rows;
  } catch (err) {
    console.warn(`[ingest-rulings] Cache miss/invalid (${(err as Error).message}); fetching eval test split from mirror -> ${TEST_SPLIT_PATH}`);
    const raw = await fetchJsonl(`${MIRROR_BASE}/test.jsonl`, "eval test split");
    const parsed = raw.map(parseDatasetRow).filter((r): r is ParsedDatasetRow => r !== null && isUsableTestRow(r));
    if (parsed.length === 0) throw new Error("[ingest-rulings] eval test split parsed to zero usable rows — refusing to proceed unguarded.");
    await writeJsonlAtomic(cachePath, parsed);
    console.log(`[ingest-rulings] Cached ${parsed.length} eval test-split rows`);
    return parsed;
  }
}

/** Shape of the CROSS `/api/search` response we rely on. */
interface CrossSearchResponse {
  rulings: RawCrossRuling[];
}

/** Fetch one page of CROSS results, failing loudly on an unexpected body shape. */
async function fetchCrossPage(term: string, page: number): Promise<RawCrossRuling[]> {
  const url = `${CROSS_SEARCH}?term=${encodeURIComponent(term)}&collection=ALL&pageSize=${PAGE_SIZE}&page=${page}`;
  const body = await fetchWithRetry(url, `CROSS "${term}" p${page}`, (res) => res.json() as Promise<unknown>);
  if (body === null || typeof body !== "object" || !Array.isArray((body as CrossSearchResponse).rulings)) {
    // Mirror ingest-hts's Array guard: a malformed/error page is deterministic —
    // fail rather than treat a missing `rulings` key as "no results".
    throw new Error(
      `CROSS "${term}" p${page}: expected an object with a rulings[] array, got ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return (body as CrossSearchResponse).rulings.filter((r) => r.rulingNumber);
}

/**
 * Fetch CROSS rulings bucketed per seed term, then round-robin merge (via the
 * pure `roundRobinDedupe`) so the seed spans HTS chapters evenly instead of
 * being dominated by whichever terms are queried first.
 *
 * A term that fails after retries is warned and skipped with its partial bucket
 * kept — so a total CROSS outage yields zero rulings and triggers the fallback
 * in `main`, rather than an unhandled rejection aborting before the fallback.
 */
async function fetchCrossRulings(target: number): Promise<RawCrossRuling[]> {
  const buckets: RawCrossRuling[][] = [];

  for (const term of SEED_TERMS) {
    const bucket: RawCrossRuling[] = [];
    try {
      for (let page = 1; page <= MAX_PAGES_PER_TERM; page++) {
        const rulings = await fetchCrossPage(term, page);
        if (rulings.length === 0) break;
        bucket.push(...rulings);
        await sleep(POLITE_DELAY_MS);
      }
    } catch (err) {
      console.warn(`[ingest-rulings] term "${term}" failed after retries: ${(err as Error).message} — skipping this term.`);
    }
    buckets.push(bucket);
    console.log(`[ingest-rulings] term "${term}": ${bucket.length} rulings`);
  }

  // Over-fetch so leakage filtering still leaves ~target survivors.
  return roundRobinDedupe(buckets, Math.ceil(target * 1.4));
}

/** Fallback seed: non-test flexifyai rows (train + validation), no ruling numbers. */
async function fetchFallbackRows(target: number): Promise<ParsedDatasetRow[]> {
  console.warn(
    "[ingest-rulings] ⚠ CROSS API yielded no rulings — falling back to non-test " +
      "flexifyai rows. These are description→code pairs without ruling numbers, so " +
      "citations lose interpretive substance (flag this in the write-up).",
  );
  const rows: ParsedDatasetRow[] = [];
  for (const split of ["validation", "train"]) {
    if (rows.length >= target) break;
    try {
      const raw = await fetchJsonl(`${MIRROR_BASE}/${split}.jsonl`, `fallback ${split}`);
      for (const r of raw) {
        const parsed = parseDatasetRow(r);
        if (parsed) rows.push(parsed);
        if (rows.length >= target) break;
      }
    } catch (err) {
      // Keep whatever an earlier split already contributed rather than discarding it.
      console.warn(`[ingest-rulings] fallback split "${split}" failed: ${(err as Error).message} — continuing with ${rows.length} rows so far.`);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const { out, target } = parseArgs(process.argv.slice(2));
  const outPath = resolve(process.cwd(), out);

  // Hard dependency: no usable test split -> cannot guarantee AE4 -> refuse to write.
  const testRows = await ensureTestSplit();
  const index = buildLeakageIndex(testRows.map((r) => r.description));

  console.log(`[ingest-rulings] Fetching CROSS rulings (target ~${target} after leakage filter)...`);
  const raw = await fetchCrossRulings(target);
  console.log(`[ingest-rulings] Fetched ${raw.length} unique CROSS rulings`);

  let chunks: RulingChunk[];
  let usedFallback = false;

  if (raw.length === 0) {
    usedFallback = true;
    const fallbackRows = await fetchFallbackRows(Math.ceil(target * 1.2));
    chunks = fallbackRows.map((r, i) => toFallbackChunk(r, i));
  } else {
    chunks = raw.map(toRulingChunk).filter((c): c is RulingChunk => c !== null);
    console.log(`[ingest-rulings] ${chunks.length} rulings had a usable subject + tariff`);
  }

  const { kept, dropped } = excludeLeakage(chunks, index);
  console.log(
    `[ingest-rulings] Leakage guard: dropped ${dropped.length} ruling(s) matching a test-split product; ${kept.length} kept.`,
  );
  for (const d of dropped.slice(0, 10)) {
    console.log(`    dropped ${d.metadata.ruling_number}: ${d.metadata.subject_raw.slice(0, 80)}`);
  }

  // Trim to target while keeping determinism (fetch/seed order is stable).
  const seed = kept.slice(0, target);

  if (seed.length === 0) {
    throw new Error("[ingest-rulings] produced zero ruling chunks — aborting.");
  }
  // Floor applies to BOTH real and fallback runs: a truncated fallback fetch is
  // just as unusable as a truncated CROSS fetch, so neither may write thin.
  const isFullRun = outPath === resolve(process.cwd(), DEFAULT_OUT) && target >= DEFAULT_TARGET;
  if (isFullRun && seed.length < MIN_RULINGS) {
    throw new Error(
      `[ingest-rulings] full run produced only ${seed.length} rulings (< ${MIN_RULINGS})` +
        (usedFallback ? " via the fallback path" : "") +
        `. The fetch is likely truncated — refusing to write a thin corpus.`,
    );
  }

  await writeJsonlAtomic(outPath, seed);

  console.log(
    `\n[ingest-rulings] Wrote ${seed.length} ruling chunks to ${outPath}` +
      (usedFallback ? " (FALLBACK seed — no real ruling numbers)" : "") +
      `\n  Leakage-verified against ${testRows.length} eval test-split rows.` +
      `\n  NOTE: the guard only compares the fetched seed against the test split; it` +
      ` cannot vouch for test-item rulings that were never sampled (see write-up).`,
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
