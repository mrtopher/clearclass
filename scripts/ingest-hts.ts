/**
 * U2 — HTS ingestion pipeline (offline, scripted).
 *
 * Fetches the full USITC Harmonized Tariff Schedule chapter-by-chapter from the
 * public `exportList` endpoint, runs it through the hierarchy-preserving chunker
 * (`lib/chunking.ts`), and writes one JSON chunk per line to a JSONL file that
 * U4 (embedding + pgvector load) consumes. No embeddings or DB writes happen
 * here — this stage only produces citable, hierarchy-preserving chunks.
 *
 * Usage:
 *   npm run ingest:hts                      # all chapters -> data/hts-chunks.jsonl
 *   npx tsx scripts/ingest-hts.ts --chapters=61,62 --out=/tmp/hts.jsonl   # subset
 *
 * Loud-failure contract (U2): the canonical corpus is only ever written by a
 * fully-guarded run. A chapter that returns a non-array/error body throws; an
 * unrecognized CLI flag throws; an empty response from a chapter that is NOT a
 * known reserved chapter throws (rather than being silently dropped as
 * "reserved"); a subset run refuses to overwrite the canonical output path; a
 * full run below the leaf-count floor throws; and the file is written
 * atomically (temp + rename) so an interrupted run cannot leave a truncated or
 * clobbered corpus on disk.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chunkHtsRows, type HtsChunk, type HtsRow } from "@/lib/chunking";

const EXPORT_BASE = "https://hts.usitc.gov/reststop/exportList";
const FIRST_CHAPTER = 1;
const LAST_CHAPTER = 99;
/** Chapters known to be reserved/unused in the schedule (return an empty array). */
const RESERVED_CHAPTERS = new Set<number>([77]);
/**
 * Sanity floor for a full run. The live schedule has ~23k leaf lines; the floor
 * sits below that with headroom for legitimate schedule shrinkage, but high
 * enough that losing a whole chapter (or a large truncation) trips it. It is a
 * coarse backstop — the per-chapter empty-response guard above is the primary
 * defense against silent drops.
 */
const MIN_EXPECTED_LEAVES = 20_000;
const MAX_FETCH_ATTEMPTS = 3;
/** Per-request timeout — Node's global fetch has none, so a hung socket would otherwise stall the run forever. */
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_OUT = "data/hts-chunks.jsonl";

/** Known codes hand-verified after a run (execution note: spot-check ancestry). */
const SPOT_CHECK_CODES = ["0101.21.00.10", "6109.10.00.12"];

export interface Args {
  chapters: number[];
  out: string;
}

/** A deterministic fetch failure (bad request, malformed body) that retrying cannot fix. */
class NonRetryableFetchError extends Error {}

export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

export function parseArgs(argv: string[]): Args {
  let chapters = range(FIRST_CHAPTER, LAST_CHAPTER);
  let out = DEFAULT_OUT;
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "chapters" && value) {
      chapters = value.split(",").map((c) => {
        const n = Number.parseInt(c.trim(), 10);
        if (Number.isNaN(n) || n < FIRST_CHAPTER || n > LAST_CHAPTER) {
          throw new Error(
            `Invalid --chapters value: ${JSON.stringify(c)} ` +
              `(expected ${FIRST_CHAPTER}-${LAST_CHAPTER})`,
          );
        }
        return n;
      });
    } else if (key === "out" && value) {
      out = value;
    } else {
      // Fail loud on typos (e.g. --chpaters=61) rather than silently falling
      // back to a full-schedule run with a mis-scoped intent.
      throw new Error(
        `Unrecognized argument: ${JSON.stringify(arg)}. ` +
          `Supported: --chapters=<n,n,...> --out=<path>`,
      );
    }
  }
  return { chapters, out };
}

export function chapterHeadingRange(chapter: number): { from: string; to: string } {
  const cc = String(chapter).padStart(2, "0");
  return { from: `${cc}01`, to: `${cc}99` };
}

async function fetchChapter(chapter: number): Promise<HtsRow[]> {
  const { from, to } = chapterHeadingRange(chapter);
  const url = `${EXPORT_BASE}?from=${from}&to=${to}&format=JSON&styles=false`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        const msg = `HTTP ${res.status} ${res.statusText} for ${url}`;
        // 5xx/429 may be transient; other 4xx (e.g. a bad range) will not
        // fix themselves, so surface them after a single attempt.
        if (res.status >= 500 || res.status === 429) throw new Error(msg);
        throw new NonRetryableFetchError(msg);
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        // A malformed/error page (e.g. {status:400,...}) is deterministic —
        // fail immediately rather than retrying or treating it as "no rows".
        throw new NonRetryableFetchError(
          `Chapter ${chapter}: expected a JSON array, got ${typeof body} — ` +
            `${JSON.stringify(body).slice(0, 200)}`,
        );
      }
      return body as HtsRow[];
    } catch (err) {
      if (err instanceof NonRetryableFetchError) throw err;
      lastError = err;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        const backoffMs = 500 * 2 ** (attempt - 1);
        console.warn(
          `[ingest-hts] chapter ${chapter} attempt ${attempt} failed: ` +
            `${(err as Error).message} — retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
      }
    }
  }
  throw new Error(
    `[ingest-hts] chapter ${chapter} failed after ${MAX_FETCH_ATTEMPTS} attempts: ` +
      `${(lastError as Error).message}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printSpotChecks(chunks: HtsChunk[]): void {
  const byCode = new Map(chunks.map((c) => [c.metadata.hts_code, c]));
  const present = SPOT_CHECK_CODES.filter((code) => byCode.has(code));
  if (present.length === 0) {
    console.log(
      "\n[ingest-hts] (no spot-check codes present in this run's chapters)",
    );
    return;
  }

  console.log("\n[ingest-hts] Spot-checks (hand-verify ancestry + metadata):");
  for (const code of present) {
    const c = byCode.get(code)!;
    console.log(`\n  ${code}`);
    console.log(`    chapter=${c.metadata.chapter} heading=${c.metadata.heading} subheading=${c.metadata.subheading}`);
    console.log(`    units=${JSON.stringify(c.metadata.units)} general_duty=${JSON.stringify(c.metadata.general_duty)}`);
    console.log(`    path: ${c.content}`);
  }
}

async function main(): Promise<void> {
  const { chapters, out } = parseArgs(process.argv.slice(2));
  const isFullRun = chapters.length === LAST_CHAPTER - FIRST_CHAPTER + 1;
  const outPath = resolve(process.cwd(), out);

  // A partial run must not clobber the canonical corpus that downstream units
  // trust — its count floor is bypassed (isFullRun=false), so require an
  // explicit alternate --out for subset/spot-check runs.
  if (!isFullRun && outPath === resolve(process.cwd(), DEFAULT_OUT)) {
    throw new Error(
      `[ingest-hts] refusing to overwrite the canonical corpus ` +
        `(${DEFAULT_OUT}) with a partial ${chapters.length}-chapter run. ` +
        `Pass --out=<path> for a subset run, or run all chapters.`,
    );
  }

  console.log(
    `[ingest-hts] Fetching ${chapters.length} chapter(s) from USITC; ` +
      `output -> ${outPath}`,
  );

  const allChunks: HtsChunk[] = [];
  let reservedSkipped = 0;

  for (const chapter of chapters) {
    const cc = String(chapter).padStart(2, "0");
    const rows = await fetchChapter(chapter);
    if (rows.length === 0) {
      if (!RESERVED_CHAPTERS.has(chapter)) {
        // An empty response from a populated chapter means a transient/truncated
        // response, not "reserved" — fail loud instead of silently dropping it.
        throw new Error(
          `[ingest-hts] chapter ${cc} returned an empty array but is not a ` +
            `known reserved chapter. Refusing to silently drop it — re-run, ` +
            `and if it persists verify the chapter at hts.usitc.gov.`,
        );
      }
      reservedSkipped++;
      continue;
    }
    const chunks = chunkHtsRows(rows);
    allChunks.push(...chunks);
    console.log(
      `[ingest-hts] chapter ${cc}: ${rows.length} rows -> ${chunks.length} leaf chunks`,
    );
  }

  if (allChunks.length === 0) {
    throw new Error("[ingest-hts] produced zero chunks — aborting.");
  }
  if (isFullRun && allChunks.length < MIN_EXPECTED_LEAVES) {
    throw new Error(
      `[ingest-hts] full run produced only ${allChunks.length} leaf chunks ` +
        `(< ${MIN_EXPECTED_LEAVES} expected). The schedule is likely truncated — ` +
        `refusing to write a partial corpus.`,
    );
  }

  // Atomic write: stage to a temp sibling then rename into place, so an
  // interrupted write can never truncate or clobber an existing good corpus.
  await mkdir(dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.tmp`;
  const jsonl = allChunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
  await writeFile(tmpPath, jsonl, "utf8");
  await rename(tmpPath, outPath);

  console.log(
    `\n[ingest-hts] Wrote ${allChunks.length} chunks` +
      (reservedSkipped ? ` (${reservedSkipped} reserved chapter(s) skipped)` : "") +
      ` to ${outPath}`,
  );
  printSpotChecks(allChunks);
}

// Only run when invoked directly (not when imported by tests), so importing the
// pure helpers above never triggers a live network fetch.
const isEntrypoint =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
