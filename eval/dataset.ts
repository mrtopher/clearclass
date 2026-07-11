/**
 * U10 — eval dataset loading + the AE4 leakage assertion.
 *
 * This is the shared "read the ground truth, and prove it isn't in the corpus"
 * layer for the eval harness. Two responsibilities:
 *
 *  1. **Dataset loading** (`loadTestRows`, `cleanQuery`, `TestRow`). The 200-row
 *     flexifyai test split is the eval ground truth for BOTH the U5 recall
 *     harness and the U10 accuracy/RAG suites, so its loader and the
 *     question-framing normalizer live here — one source of truth that
 *     `eval/retrieval-recall.ts` re-exports so its callers/tests are unchanged.
 *
 *  2. **The AE4 leakage assertion** (`findLeakage`, `assertNoLeakage`). Before
 *     scoring, the harness must prove no test-split ruling is present in the
 *     retrievable corpus (AE4) — otherwise a "gain" could be the model reading
 *     back the answer key. U3 already EXCLUDES leaked rulings at ingest via
 *     product-description similarity (the mirror carries no ruling IDs — see the
 *     leakage memory); this re-runs the exact same guard (`maxLeakSimilarity`)
 *     against what is ACTUALLY in the DB, so a re-ingest that forgot the filter
 *     is caught at eval time, not silently scored.
 *
 * SDK-free by design (like `dense.ts`): the DB read goes through the PostgREST
 * proxy with `fetch` so this runs under a plain tsx script. The pure core
 * (`findLeakage`) is dependency-free and unit-tested without a network.
 */
import { resolve } from "node:path";

import { readJsonl } from "@/lib/corpus-io";
import {
  adminFetch,
  authHeaders,
  type AdminConfig,
} from "@/lib/insforge-admin";
import {
  buildLeakageIndex,
  maxLeakSimilarity,
  LEAKAGE_SIMILARITY_THRESHOLD,
} from "@/lib/rulings";

/** The eval ground-truth file: the flexifyai 200-row test split. */
export const DEFAULT_SPLIT = "data/eval-test-split.jsonl";

/** One eval test row: a product-description question and its gold HTS code. */
export interface TestRow {
  description: string;
  gold_hts: string;
  /** The dataset's gold rationale, when present — used as the RAG `expected`
   *  ground-truth answer (U10 suite 3). Absent rows simply omit it. */
  reasoning?: string;
}

/**
 * The eval dataset phrases every row as a chat question — "What is the HTS US
 * Code for <product>?" — which is a dataset artifact, NOT what the agent sees in
 * production (a broker submits a product description, not a question). Embedding
 * the interrogative framing pushes the query vector toward "question" text and
 * away from the terse tariff-line language, depressing retrieval on a scenario
 * that never occurs live. Stripping it to the bare product phrase measures the
 * system as it is actually exercised. Light touch only (prefix + trailing "?"):
 * case and content are preserved so the embedding still sees natural language.
 */
const QUESTION_PREFIX =
  /^\s*what\s+is\s+the\s+(hts|harmonized|tariff|classification|proper)\b[^?]*?\b(for|of)\s+/i;

export function cleanQuery(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  const stripped = collapsed.replace(QUESTION_PREFIX, "").replace(/\?+\s*$/, "").trim();
  // Never hand back an empty query (a row that was ALL boilerplate) — fall back
  // to the original so the row is still scored rather than silently short-circuited.
  return stripped || collapsed;
}

/**
 * PURE validation of raw dataset records into trustworthy `TestRow`s; a row
 * missing description/gold code is fatal (the ground truth must be trustworthy
 * before anything is scored against it). `i` is the record ordinal (blank lines
 * already skipped by `readJsonl`), NOT a file line number — labelled as a row
 * index so it doesn't misdirect debugging. Split out from `loadTestRows` so the
 * validation contract is unit-tested without touching the filesystem.
 */
export function toTestRows(
  raw: readonly Partial<TestRow>[],
  split: string = DEFAULT_SPLIT,
): TestRow[] {
  const rows: TestRow[] = raw.map((r, i) => {
    if (!r || typeof r.description !== "string" || !r.description.trim()) {
      throw new Error(`[eval] ${split} row ${i + 1} is missing a description`);
    }
    if (typeof r.gold_hts !== "string" || !r.gold_hts.trim()) {
      throw new Error(`[eval] ${split} row ${i + 1} is missing a gold_hts code`);
    }
    const reasoning = typeof r.reasoning === "string" && r.reasoning.trim() ? r.reasoning.trim() : undefined;
    return { description: r.description.trim(), gold_hts: r.gold_hts.trim(), reasoning };
  });
  if (rows.length === 0) throw new Error(`[eval] ${split} has no rows — aborting.`);
  return rows;
}

/** Load, validate, and optionally truncate the eval test split from disk. */
export async function loadTestRows(
  split: string = DEFAULT_SPLIT,
  limit: number | null = null,
): Promise<TestRow[]> {
  const absPath = resolve(process.cwd(), split);
  const raw = await readJsonl<Partial<TestRow>>(absPath);
  const rows = toTestRows(raw, split);
  return limit ? rows.slice(0, limit) : rows;
}

// ── AE4: no test-split ruling is retrievable from the corpus ───────────────────

/** One retrievable ruling that describes the same product as a test-split row. */
export interface LeakageViolation {
  /** The ruling's product subject (`metadata.subject_raw`) that matched. */
  subject: string;
  /** The test-split description it collided with. */
  testDescription: string;
  /** Their product similarity — at or above `threshold` is a leak. */
  similarity: number;
}

/** The outcome of the AE4 check: how many rulings were inspected, and any leaks. */
export interface LeakageReport {
  /** Number of retrievable ruling subjects checked. */
  checked: number;
  /** The similarity threshold applied (`LEAKAGE_SIMILARITY_THRESHOLD`). */
  threshold: number;
  /** Rulings whose product matches a test-split row above threshold — must be empty. */
  violations: LeakageViolation[];
}

/**
 * PURE AE4 core: which retrievable ruling subjects collide with a test-split
 * product above threshold? Reuses the EXACT ingest-time guard
 * (`buildLeakageIndex` / `maxLeakSimilarity`) so this cannot disagree with what
 * U3 filtered on — the assertion proves the guard held in the DB, it does not
 * invent a second, weaker notion of "same product". Returns the (ruling, test)
 * pair and score for every violation so a failure names exactly what leaked.
 */
export function findLeakage(
  rulingSubjects: readonly string[],
  testDescriptions: readonly string[],
  threshold: number = LEAKAGE_SIMILARITY_THRESHOLD,
): LeakageViolation[] {
  const index = buildLeakageIndex([...testDescriptions], threshold);
  const violations: LeakageViolation[] = [];
  for (const subject of rulingSubjects) {
    if (!subject.trim()) continue;
    const similarity = maxLeakSimilarity(subject, index);
    if (similarity >= threshold) {
      // Name the specific test row it collided with, so the failure is actionable
      // (which seed ruling to drop, against which test description).
      let worst = { testDescription: "", score: 0 };
      for (const testDescription of testDescriptions) {
        const s = maxLeakSimilarity(subject, buildLeakageIndex([testDescription], threshold));
        if (s > worst.score) worst = { testDescription, score: s };
      }
      violations.push({ subject, testDescription: worst.testDescription, similarity });
    }
  }
  return violations;
}

const DOCUMENTS_TABLE = "documents";
/** PostgREST enforces a server-side max rows PER PAGE (1000 on this proxy),
 *  regardless of a larger `limit`. The corpus broadened to 2000 rulings, so a
 *  single-page read now silently truncates — `createFetchRulingSubjects` pages
 *  through with `offset` and reconciles against the Content-Range total instead. */
const RULING_PAGE_SIZE = 1000;
/** Hard cap on pages to page through, so a proxy that never advances the offset
 *  (or a runaway total) can't spin forever. 100 pages × 1000 = 100k rulings, far
 *  above any plausible seed — hitting it is a defect, not a legitimate corpus. */
const RULING_MAX_PAGES = 100;

/** Fetch the product subject of every retrievable ruling chunk from the corpus. */
export type FetchRulingSubjects = () => Promise<string[]>;

/**
 * Build a `FetchRulingSubjects` that reads `metadata->subject_raw` for every
 * `type = 'ruling'` document through the PostgREST proxy (admin key: the corpus
 * is shared reference data, not per-tenant — same rationale as `dense.ts`). A
 * ruling missing `subject_raw` falls back to its `content` so it is still checked
 * rather than silently skipped. Throws if the corpus holds more rulings than one
 * page returns, so the assertion never reports "clean" over a truncated read.
 */
export function createFetchRulingSubjects(cfg: AdminConfig): FetchRulingSubjects {
  return async () => {
    type RulingRow = { metadata?: { subject_raw?: unknown }; content?: unknown };
    const rows: RulingRow[] = [];
    // Page through with `offset`, reconciling against the Content-Range total so
    // the assertion covers the WHOLE corpus, not just the first (server-capped)
    // page. `count=exact` makes every page carry a "start-end/total" range.
    let total = Number.POSITIVE_INFINITY;
    for (let page = 0; rows.length < total; page++) {
      if (page >= RULING_MAX_PAGES) {
        throw new Error(
          `[eval:leakage] exceeded ${RULING_MAX_PAGES} pages fetching rulings (offset ${rows.length}, ` +
            `total ${total}) — refusing to spin; the proxy is not advancing or the corpus is implausibly large.`,
        );
      }
      const url =
        `${cfg.baseUrl}/api/database/records/${DOCUMENTS_TABLE}` +
        `?type=eq.ruling&select=metadata,content&limit=${RULING_PAGE_SIZE}&offset=${rows.length}`;
      const res = await adminFetch(url, {
        method: "GET",
        headers: { ...authHeaders(cfg), Prefer: "count=exact" },
      });
      if (!res.ok) {
        throw new Error(
          `[eval:leakage] fetching ruling subjects failed: HTTP ${res.status}: ` +
            `${(await res.text()).slice(0, 300)}`,
        );
      }
      const pageRows = (await res.json()) as RulingRow[];
      if (!Array.isArray(pageRows)) {
        throw new Error("[eval:leakage] expected an array of ruling rows");
      }
      // Fail CLOSED when the count is unverifiable. `count=exact` should return a
      // finite "start-end/total"; a MISSING/unbounded total ("*", or header
      // stripped) means we cannot know when the read is complete — and treating
      // "I can't see the count" as success is the silent pass AE4 exists to avoid.
      const pageTotal = Number.parseInt(res.headers.get("content-range")?.split("/")[1] ?? "", 10);
      if (!Number.isFinite(pageTotal)) {
        throw new Error(
          "[eval:leakage] ruling page returned no verifiable count (Content-Range absent/unbounded) — " +
            "refusing to certify AE4 over a read whose completeness can't be established.",
        );
      }
      total = pageTotal;
      rows.push(...pageRows);
      // No forward progress before reaching the total means the proxy is stuck or
      // the total is inconsistent — fail closed rather than loop or under-read.
      if (pageRows.length === 0 && rows.length < total) {
        throw new Error(
          `[eval:leakage] ruling paging stalled at ${rows.length}/${total} (empty page) — ` +
            "refusing to certify AE4 over an incomplete read.",
        );
      }
    }
    return rows.map((r) => {
      const subject = r.metadata?.subject_raw;
      if (typeof subject === "string" && subject.trim()) return subject;
      return typeof r.content === "string" ? r.content : "";
    });
  };
}

/**
 * Assert AE4: no retrievable ruling describes the same product as any test-split
 * row. Fetches the corpus ruling subjects, runs the pure `findLeakage` guard, and
 * returns the report. The CALLER decides fatality (the harness aborts the whole
 * run on any violation — see `eval/run.ts`) so this stays testable without a
 * process exit.
 */
export async function assertNoLeakage(
  testDescriptions: readonly string[],
  fetchSubjects: FetchRulingSubjects,
  threshold: number = LEAKAGE_SIMILARITY_THRESHOLD,
): Promise<LeakageReport> {
  const subjects = await fetchSubjects();
  // Fail CLOSED on an empty read. `findLeakage([])` is vacuously "clean", so a
  // corpus that is empty, mis-typed (no `type = 'ruling'` rows), or read through
  // a soft-failing proxy would certify AE4 GREEN having inspected NOTHING — a
  // guard that proves a negative by never running. The corpus is known to seed
  // rulings, so zero is always a defect, not a clean result.
  if (subjects.length === 0) {
    throw new Error(
      "[eval:leakage] fetched zero retrievable rulings — the corpus is empty, the ruling type is " +
        "mislabelled, or the read silently failed. Refusing to certify AE4 clean over an empty check.",
    );
  }
  const violations = findLeakage(subjects, testDescriptions, threshold);
  return { checked: subjects.length, threshold, violations };
}
