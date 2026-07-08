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
 *   npx tsx scripts/ingest-hts.ts --chapters=61,62   # subset (fast spot-check)
 *   npx tsx scripts/ingest-hts.ts --out=/tmp/hts.jsonl
 *
 * Loud-failure contract (U2): a chapter that returns a non-array / error body
 * throws immediately; a genuinely empty reserved chapter (e.g. 77) is skipped.
 * A full run whose total leaf count is implausibly low also throws, so a
 * silently truncated schedule can never masquerade as a complete corpus.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { chunkHtsRows, type HtsChunk, type HtsRow } from "@/lib/chunking";

const EXPORT_BASE = "https://hts.usitc.gov/reststop/exportList";
/** Chapters 1–99 (77 is reserved and returns []). */
const FIRST_CHAPTER = 1;
const LAST_CHAPTER = 99;
/** Sanity floor for a full run — the real schedule has ~19k leaf lines. */
const MIN_EXPECTED_LEAVES = 15_000;
const MAX_FETCH_ATTEMPTS = 3;
const DEFAULT_OUT = "data/hts-chunks.jsonl";

/** Known codes hand-verified after a run (execution note: spot-check ancestry). */
const SPOT_CHECK_CODES = ["0101.21.00.10", "6109.10.00.12"];

interface Args {
  chapters: number[];
  out: string;
}

function parseArgs(argv: string[]): Args {
  let chapters = range(FIRST_CHAPTER, LAST_CHAPTER);
  let out = DEFAULT_OUT;
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "chapters" && value) {
      chapters = value.split(",").map((c) => {
        const n = Number.parseInt(c.trim(), 10);
        if (Number.isNaN(n) || n < 1 || n > 99) {
          throw new Error(`Invalid --chapters value: ${JSON.stringify(c)}`);
        }
        return n;
      });
    } else if (key === "out" && value) {
      out = value;
    }
  }
  return { chapters, out };
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function chapterHeadingRange(chapter: number): { from: string; to: string } {
  const cc = String(chapter).padStart(2, "0");
  return { from: `${cc}01`, to: `${cc}99` };
}

async function fetchChapter(chapter: number): Promise<HtsRow[]> {
  const { from, to } = chapterHeadingRange(chapter);
  const url = `${EXPORT_BASE}?from=${from}&to=${to}&format=JSON&styles=false`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        // A malformed/error page (e.g. {status:400,...}) must fail loudly
        // rather than be treated as "no rows".
        throw new Error(
          `Chapter ${chapter}: expected a JSON array, got ${typeof body} — ` +
            `${JSON.stringify(body).slice(0, 200)}`,
        );
      }
      return body as HtsRow[];
    } catch (err) {
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
  if (present.length === 0) return;

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

  console.log(
    `[ingest-hts] Fetching ${chapters.length} chapter(s) from USITC; ` +
      `output -> ${outPath}`,
  );

  const allChunks: HtsChunk[] = [];
  let emptyChapters = 0;

  for (const chapter of chapters) {
    const rows = await fetchChapter(chapter);
    if (rows.length === 0) {
      emptyChapters++;
      continue; // reserved chapter (e.g. 77) — legitimately empty
    }
    const chunks = chunkHtsRows(rows);
    allChunks.push(...chunks);
    console.log(
      `[ingest-hts] chapter ${String(chapter).padStart(2, "0")}: ` +
        `${rows.length} rows -> ${chunks.length} leaf chunks`,
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

  await mkdir(dirname(outPath), { recursive: true });
  const jsonl = allChunks.map((c) => JSON.stringify(c)).join("\n") + "\n";
  await writeFile(outPath, jsonl, "utf8");

  console.log(
    `\n[ingest-hts] Wrote ${allChunks.length} chunks` +
      (emptyChapters ? ` (${emptyChapters} empty/reserved chapter(s) skipped)` : "") +
      ` to ${outPath}`,
  );
  printSpotChecks(allChunks);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
