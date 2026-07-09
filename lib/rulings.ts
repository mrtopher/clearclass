/**
 * CBP CROSS ruling normalization + the U3 leakage guard (R2, AE4).
 *
 * This module is intentionally pure (no network, no fs) so the integrity-
 * critical leakage logic is fully unit-testable with fixtures;
 * `scripts/ingest-rulings.ts` owns fetching and persistence — the same split
 * `lib/chunking.ts` / `scripts/ingest-hts.ts` use for HTS (U2).
 *
 * ── Why similarity, not ruling IDs ────────────────────────────────────────
 * The plan's original leakage mechanism was "exclude any seeded ruling whose
 * `ruling_number` is in the eval test split." That is infeasible against the
 * data we actually have: the public flexifyai mirror
 * (`Dayanand314Krishna/cross_rulings_hts_dataset_for_tariffs`) is a chat-format
 * dataset carrying only a product-description question and a gold HTS code — no
 * ruling numbers to intersect on. The *intent* of R2/AE4 is preserved with a
 * different key: a seeded CROSS ruling is dropped when its subject describes the
 * SAME PRODUCT as any test-split row, measured by normalized token similarity.
 * The guard is deliberately biased toward over-exclusion — dropping a few extra
 * rulings only marginally trims the seed, whereas keeping a leaked one is the
 * graded failure (AE4).
 */

/** One raw record from `rulings.cbp.gov/api/search`. */
export interface RawCrossRuling {
  /** e.g. "N123456", "HQ H987654". Unique per ruling. */
  rulingNumber: string;
  /** Free-text product/subject line. */
  subject: string;
  /** Assigned HTS code(s); may be null or empty on non-classification rulings. */
  tariffs: string[] | null;
  /** ISO datetime, e.g. "2019-05-01T00:00:00". */
  rulingDate: string;
  /** CROSS collection ("ny" | "hq" | ...). */
  collection?: string;
}

export interface RulingChunk {
  /** Materialized text for embedding: ruling number + product subject + code. */
  content: string;
  /** Corpus type discriminator for the shared `documents` table (U4). */
  type: "ruling";
  metadata: {
    /** Canonical CROSS ruling identifier — the citation handle. */
    ruling_number: string;
    /** Primary assigned HTS code (first tariff), dotted 10-digit form. */
    hts_code: string;
    /** All assigned HTS codes on the ruling. */
    hts_codes: string[];
    /** Ruling date, `YYYY-MM-DD`. */
    date: string;
    /** CROSS collection. */
    collection: string;
    /**
     * The raw subject text, kept so the eval harness (U10) can re-run the
     * leakage assertion against the corpus without re-deriving it.
     */
    subject_raw: string;
  };
}

/** Default: drop a ruling when its product similarity to a test row is >= this. */
export const LEAKAGE_SIMILARITY_THRESHOLD = 0.5;

/**
 * Function words + query/ruling framing words that carry no product signal.
 * Dropping them keeps similarity focused on the discriminative nouns/materials.
 * The framing words (`hts`, `code`, `tariff`, `classification`, ...) are exactly
 * the boilerplate that differs between the mirror's "What is the HTS US Code
 * for X?" and CROSS's "The tariff classification of X from Y", so removing them
 * lets the two phrasings of the same product line up.
 */
const STOPWORDS = new Set<string>([
  // function words
  "the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "at", "by",
  "with", "from", "as", "is", "are", "be", "this", "that", "these", "those",
  "it", "its", "their", "which", "what", "whats",
  // query / ruling framing
  "hts", "us", "code", "codes", "harmonized", "tariff", "tariffs", "schedule",
  "classification", "classify", "applicability", "status", "country", "origin",
  "ruling", "subject", "product", "item", "article",
  // CROSS administrative + letter boilerplate (subjects sometimes carry
  // "Correction to ...", "Revocation of ruling ...", "Dear Mr. Smith:"); these
  // dilute similarity for a genuinely leaked ruling if left in.
  "correction", "revocation", "modification", "reconsideration", "request",
  "letter", "dear", "mr", "mrs", "ms", "inc", "ltd", "co", "llc", "company",
]);

/**
 * CROSS origin countries. Used ONLY to gate the trailing `from <origin>` strip
 * in `normalizeProductText` — NOT as a global token filter. Several entries are
 * product homographs ("turkey" the meat, "china" the porcelain, "chile" the
 * pepper), so erasing them wherever they appear would delete discriminative
 * product nouns and let a genuinely leaked ruling slip under threshold. Consulting
 * this set only at a trailing `from ...` boundary removes "widgets from Turkey"
 * (origin) while preserving "turkey sausage" (product).
 */
const COUNTRY_WORDS = new Set<string>([
  "china", "japan", "germany", "italy", "korea", "taiwan", "vietnam", "india",
  "mexico", "canada", "france", "spain", "thailand", "malaysia", "indonesia",
  "turkey", "brazil", "netherlands", "switzerland", "sweden", "poland",
  "austria", "belgium", "ireland", "israel", "singapore", "philippines",
  "bangladesh", "pakistan", "cambodia", "hongkong", "kong", "hong", "kingdom",
  "united", "britain", "england", "denmark", "norway", "finland", "portugal",
  "greece", "czech", "hungary", "romania", "russia", "ukraine", "egypt",
  "colombia", "chile", "peru", "argentina", "australia", "zealand", "africa",
]);

/** Boilerplate prefixes to strip from the front of a description, longest first. */
const PREFIX_PATTERNS: RegExp[] = [
  /^what\s+is\s+the\s+(hts|harmonized)\b.*?\bfor\s+/i,
  /^the\s+tariff\s+classification\s+(and\s+status\s+)?of\s+/i,
  /^the\s+(classification|applicability|status)\s+of\s+/i,
  /^the\s+country\s+of\s+origin\s+of\s+/i,
];

/** Connectors permitted inside a multi-country origin clause ("china and vietnam"). */
const ORIGIN_CONNECTORS = new Set<string>(["and", "or", "the"]);

/**
 * Reduce a product description (from either source phrasing) to a stable,
 * order-preserving string of content tokens, so the two sources line up.
 * Idempotent: feeding its own output back in is a no-op.
 */
export function normalizeProductText(text: string): string {
  let s = text.toLowerCase().trim();
  for (const re of PREFIX_PATTERNS) s = s.replace(re, "");
  // Drop a trailing ORIGIN clause ("... from china", "... from china and vietnam")
  // but ONLY when every word after "from" is a known country/connector. This
  // preserves a trailing MATERIAL clause ("sweater made from cotton", "jam from
  // strawberries") — stripping those would delete the discriminative noun and
  // could let a leaked ruling slip under threshold.
  s = s.replace(/\bfrom\s+([a-z][a-z\s,&/'-]*)$/i, (match, tail: string) => {
    const words = tail.split(/[^a-z]+/i).filter(Boolean);
    const originOnly =
      words.length > 0 &&
      words.every((w) => COUNTRY_WORDS.has(w) || ORIGIN_CONNECTORS.has(w));
    return originOnly ? " " : match;
  });
  // Collapse intra-word hyphens/apostrophes so "t-shirt" -> "tshirt" and
  // "woman's" -> "womans" line up regardless of punctuation; other
  // non-alphanumerics become separators.
  const tokens = s
    .replace(/['’-]+/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(depluralize);
  return tokens.join(" ");
}

/**
 * Strip a single trailing plural "s" so "shirts"/"shirt", "gloves"/"glove", and
 * "fittings"/"fitting" match. Guards: length >= 4 and not ending in "ss" (so
 * "glass"/"dress" survive). Removing exactly one non-doubled trailing "s"
 * yields a token that never ends in "s", so the transform is idempotent — which
 * `normalizeProductText` requires.
 */
function depluralize(token: string): string {
  if (token.length >= 4 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function unigrams(normalized: string): Set<string> {
  return new Set(normalized ? normalized.split(" ") : []);
}

/** Intersection-over-union of two sets; 0 when both are empty. */
export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Precomputed token set for one description, so a corpus scan normalizes once. */
interface TokenSets {
  uni: Set<string>;
}

function tokenSets(text: string): TokenSets {
  return { uni: unigrams(normalizeProductText(text)) };
}

/**
 * Product similarity in [0,1] = max(Jaccard, containment).
 *
 * Symmetric Jaccard alone is deflated when one side is a verbose real CROSS
 * subject padded with extra descriptive tokens ("...with embroidered logo,
 * ribbed collar..."): a terse test description of the SAME product scores below
 * threshold and the ruling leaks with its gold code. Containment — the fraction
 * of the SMALLER description's tokens the larger one covers — is immune to that
 * padding, so a test description contained in a verbose ruling subject still
 * trips the guard. Containment is gated on the smaller side having >= 2 content
 * tokens so a single generic token ("plastic") cannot trivially "contain".
 */
function similarity(a: TokenSets, b: TokenSets): number {
  const minSize = Math.min(a.uni.size, b.uni.size);
  if (minSize === 0) return 0;
  let inter = 0;
  for (const x of a.uni) if (b.uni.has(x)) inter++;
  const jac = inter / (a.uni.size + b.uni.size - inter);
  const contain = minSize >= 2 ? inter / minSize : 0;
  return Math.max(jac, contain);
}

/** Public string-in similarity for tests and ad-hoc checks. */
export function productSimilarity(a: string, b: string): number {
  return similarity(tokenSets(a), tokenSets(b));
}

/** A leakage index built once from the test-split product descriptions. */
export interface LeakageIndex {
  readonly threshold: number;
  readonly testSets: readonly TokenSets[];
}

export function buildLeakageIndex(
  testDescriptions: string[],
  threshold: number = LEAKAGE_SIMILARITY_THRESHOLD,
): LeakageIndex {
  return {
    threshold,
    testSets: testDescriptions.map(tokenSets),
  };
}

/** The single ruling's peak similarity to any test-split description. */
export function maxLeakSimilarity(subject: string, index: LeakageIndex): number {
  const sets = tokenSets(subject);
  let max = 0;
  for (const t of index.testSets) {
    const s = similarity(sets, t);
    if (s > max) max = s;
    if (max >= 1) break;
  }
  return max;
}

/**
 * Merge per-term ruling buckets round-robin (one from each bucket in turn),
 * deduping by ruling number, until `limit` unique rulings are collected. Taking
 * from every bucket before returning to the first spreads the seed evenly across
 * the search terms (HTS categories) instead of exhausting the first term's
 * results first. Pure and order-deterministic so it is unit-testable without a
 * network fetch.
 */
export function roundRobinDedupe(
  buckets: RawCrossRuling[][],
  limit: number,
): RawCrossRuling[] {
  const byNumber = new Map<string, RawCrossRuling>();
  const maxDepth = Math.max(0, ...buckets.map((b) => b.length));
  for (let depth = 0; depth < maxDepth && byNumber.size < limit; depth++) {
    for (const bucket of buckets) {
      if (byNumber.size >= limit) break;
      const r = bucket[depth];
      if (r && !byNumber.has(r.rulingNumber)) byNumber.set(r.rulingNumber, r);
    }
  }
  return [...byNumber.values()];
}

/**
 * Split ruling chunks into those safe to seed (`kept`) and those that describe
 * the same product as a test-split row (`dropped`). Dropping enforces AE4.
 */
export function excludeLeakage(
  chunks: RulingChunk[],
  index: LeakageIndex,
): { kept: RulingChunk[]; dropped: RulingChunk[] } {
  const kept: RulingChunk[] = [];
  const dropped: RulingChunk[] = [];
  for (const chunk of chunks) {
    if (maxLeakSimilarity(chunk.metadata.subject_raw, index) >= index.threshold) {
      dropped.push(chunk);
    } else {
      kept.push(chunk);
    }
  }
  return { kept, dropped };
}

/**
 * Canonicalize a 10-digit HTS code to CROSS/eval-gold `4.2.4` dotted form
 * (e.g. "7307.19.9060"). This matches both what the CROSS API returns and the
 * gold codes in the flexifyai eval split, so ruling codes compare cleanly
 * against eval ground truth (U10). Note this differs from the fully-dotted
 * `4.2.2.2` form U2 stores for HTS leaves; downstream code-matching normalizes
 * to digits, so the two coexist without a forced unification here.
 */
function normalizeHtsCode(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 10)}`;
  }
  // Leave shorter/odd codes as the source wrote them (still citable).
  return raw.trim();
}

/**
 * One row of the flexifyai chat-format dataset (mirror), used both for the eval
 * test split and — when the CROSS API is unavailable — the ruling seed fallback.
 */
export interface DatasetRow {
  messages: { role: string; content: string }[];
}

export interface ParsedDatasetRow {
  /** The product-description question ("What is the HTS US Code for ...?"). */
  description: string;
  /** Gold HTS code, canonicalized to `4.2.4` form. */
  gold_hts: string;
  /** The ruling-derived reasoning text, if present. */
  reasoning: string;
}

/**
 * Parse one dataset row into `{description, gold_hts, reasoning}`, or `null` if
 * it lacks a user question or a parseable gold code. The assistant turn is
 * shaped "HTS US Code -> <code>\nReasoning -> <text>".
 */
export function parseDatasetRow(row: DatasetRow): ParsedDatasetRow | null {
  const messages = row?.messages ?? [];
  const description = (messages.find((m) => m.role === "user")?.content ?? "").trim();
  const assistant = messages.find((m) => m.role === "assistant")?.content ?? "";
  const codeMatch = assistant.match(/HTS\s+US\s+Code\s*->\s*([0-9.]+)/i);
  if (!description || !codeMatch) return null;
  const reasoning = assistant.match(/Reasoning\s*->\s*([\s\S]*)$/i)?.[1]?.trim() ?? "";
  return { description, gold_hts: normalizeHtsCode(codeMatch[1]), reasoning };
}

/**
 * Build a ruling-precedent chunk from a flexifyai dataset row, for the fallback
 * path when the live CROSS API is unavailable. These rows are
 * description→code(+reasoning) pairs with NO ruling number, so the wedge is
 * weaker than a real ruling text (flagged in the plan); the synthetic
 * `ruling_number` makes the degraded provenance explicit in every citation.
 */
export function toFallbackChunk(row: ParsedDatasetRow, index: number): RulingChunk {
  const id = `FLEXIFYAI-${String(index).padStart(5, "0")}`;
  const content =
    `CROSS-derived precedent ${id} (no ruling number — fallback seed): ` +
    `${row.description} — classified under ${row.gold_hts}.` +
    (row.reasoning ? ` ${row.reasoning}` : "");
  return {
    content,
    type: "ruling",
    metadata: {
      ruling_number: id,
      hts_code: row.gold_hts,
      hts_codes: [row.gold_hts],
      date: "",
      collection: "flexifyai-fallback",
      subject_raw: row.description,
    },
  };
}

/**
 * Convert a raw CROSS ruling into a citable, tagged chunk, or `null` when the
 * ruling is unusable as classification precedent: no assigned tariff (nothing
 * to cite a code from) or an empty subject (no product text to embed).
 */
export function toRulingChunk(raw: RawCrossRuling): RulingChunk | null {
  const subject = raw.subject?.trim() ?? "";
  const tariffs = (raw.tariffs ?? []).map((t) => t.trim()).filter(Boolean);
  if (!subject || tariffs.length === 0) return null;

  const htsCodes = tariffs.map(normalizeHtsCode);
  const date = raw.rulingDate ? raw.rulingDate.slice(0, 10) : "";
  const collection = raw.collection ?? "";

  // Materialize the citation into the text so a retrieved chunk is self-citing.
  const content =
    `CBP ruling ${raw.rulingNumber} (${date}): ${subject} ` +
    `— classified under ${htsCodes.join(", ")}.`;

  return {
    content,
    type: "ruling",
    metadata: {
      ruling_number: raw.rulingNumber,
      hts_code: htsCodes[0],
      hts_codes: htsCodes,
      date,
      collection,
      subject_raw: subject,
    },
  };
}
