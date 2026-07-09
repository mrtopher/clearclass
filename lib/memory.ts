/**
 * U7 — per-importer classification memory (R8).
 *
 * Durable, tenant-isolated decision history that (a) surfaces prior similar
 * classifications as PRECEDENT injected into the agent context before it
 * classifies (AE3), and (b) persists each decision-of-record so future runs for
 * the same importer stay consistent — consistency being itself a CBP-facing
 * defensibility argument (KTD7).
 *
 * ─ Isolation lives in the transport (KTD10) ──────────────────────────────────
 * Unlike the corpus retriever (`lib/retrieval/dense.ts`), which uses the admin
 * key and BYPASSES RLS because `documents` is shared reference data, this module
 * reads and writes `classifications` through the request's AUTHENTICATED SSR
 * client (`getServerClient`). That client carries the broker's verified JWT, so
 * the `classifications` RLS policies ("members read importer history" /
 * "members insert own decisions") govern every call — a broker physically cannot
 * read or write another importer's history even if this app layer had a bug. The
 * `match_classifications` RPC ALSO filters by the server-derived importer, so the
 * effective importer (not merely every importer the broker can read) scopes the
 * precedent. Belt (RLS) and suspenders (the WHERE).
 *
 * ─ Best-effort, never load-bearing ───────────────────────────────────────────
 * Memory is an ENHANCEMENT to a classification, not a precondition. The agent
 * loop (`lib/agent.ts`) treats both calls as best-effort: a precedent-read outage
 * degrades to "no precedent", and a persist failure is logged but never fails the
 * broker's answer. So this module's job is to do the I/O and validate its shape;
 * the caller owns the try/catch that keeps a memory hiccup off the billable path.
 *
 * ─ Testing seam ──────────────────────────────────────────────────────────────
 * Mirroring `lib/agent.ts` and `lib/retrieval/dense.ts`, all I/O is injectable
 * (`MemoryDeps`: embed / search / insert). The pure helpers (`formatPrecedent`,
 * `toPrecedentMatch`, `toDecisionRecord`) and `createMemory` wired over fakes are
 * unit-tested with no gateway and no database.
 */
import { getServerClient } from "@/lib/auth";
import { embedTexts } from "@/lib/llm";
import type { TenantContext } from "@/lib/auth";
import type { ClassificationResult } from "@/lib/schema";

/** How many prior decisions to consider as precedent for a single classification. */
export const PRECEDENT_K = 5;

/**
 * Cosine-similarity floor below which a past decision is treated as unrelated and
 * NOT injected. `text-embedding-3-small` scores genuinely similar products well
 * above this; the floor keeps an importer's single unrelated prior decision from
 * polluting the prompt for a brand-new product. The model is still told to
 * "classify on the merits", so this is a noise filter, not a hard gate.
 */
export const PRECEDENT_MIN_SIMILARITY = 0.3;

/**
 * Wall-clock bound on a single memory operation (the embedding + RPC read, or the
 * embedding + insert). Memory is best-effort and sits on the BILLABLE request
 * path — before synthesis (precedent) and after it (persist) — so a hung or
 * retry-looping gateway/DB must not stall the request. `try/catch` catches an
 * error but never a promise that simply never settles; this converts that hang
 * into a rejection the caller degrades on, mirroring the model loop's own
 * `GENERATE_TIMEOUT_MS`. Kept short: precedent is an enhancement, not the answer.
 */
export const MEMORY_TIMEOUT_MS = 5_000;

/** A prior decision returned by `match_classifications`, ranked by similarity. */
export interface PrecedentMatch {
  product_description: string;
  chosen_hts: string;
  confidence: number | null;
  reasoning: string | null;
  /** 1 - cosine distance; higher is closer (in [-1, 1]). */
  similarity: number;
}

/** A row ready to INSERT into `public.classifications` (RLS validates it). */
export interface DecisionRecord {
  importer_id: string;
  /** The deciding broker — must equal `auth.uid()` for the RLS INSERT policy. */
  user_id: string;
  product_description: string;
  product_embedding: number[];
  chosen_hts: string;
  confidence: number | null;
  reasoning: string | null;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Collapse newlines/whitespace and strip control characters. Stored fields
 * (`product_description`, `chosen_hts`) originate as user-influenced text and are
 * rendered into the system prompt as precedent; flattening them to a single clean
 * line means a crafted value cannot break out of its bullet or inject prompt
 * lines. This is the app-layer complement to the untrusted-data framing the
 * system prompt now wraps the whole precedent block in (`buildSystemPrompt`).
 */
function sanitizeLine(text: string): string {
  // Replace C0 control chars + DEL (newlines/tabs included) with a space, then
  // collapse whitespace runs, so a crafted stored value stays on one prompt line.
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

function trimTo(text: string, max: number): string {
  const t = sanitizeLine(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Race a best-effort memory promise against {@link MEMORY_TIMEOUT_MS}. On timeout
 * the returned promise rejects (the caller degrades: no precedent / persist
 * skipped), while a late settlement of `promise` is swallowed so a slow call that
 * finishes after the deadline never surfaces as an unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[memory] ${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Validate one row from the `match_classifications` RPC into a `PrecedentMatch`,
 * or `null` if it is malformed. Returns null (rather than throwing) because a
 * single bad history row should degrade precedent gracefully, not abort the whole
 * best-effort read — the caller filters the nulls out.
 */
export function toPrecedentMatch(value: unknown): PrecedentMatch | null {
  const v = value as Partial<PrecedentMatch> | null;
  if (!v || typeof v !== "object") return null;
  if (typeof v.chosen_hts !== "string" || !v.chosen_hts) return null;
  if (typeof v.similarity !== "number") return null;
  return {
    product_description:
      typeof v.product_description === "string" ? v.product_description : "",
    chosen_hts: v.chosen_hts,
    confidence: typeof v.confidence === "number" ? v.confidence : null,
    reasoning: typeof v.reasoning === "string" ? v.reasoning : null,
    similarity: v.similarity,
  };
}

/**
 * Render precedent matches into the block injected under the system prompt's U7
 * hook (`buildSystemPrompt({ precedent })`). Empty input → "" so the agent omits
 * the precedent section entirely (a new importer with no history classifies
 * exactly as U6 did). Each line is compact — description, chosen code, confidence
 * — so several precedents fit without crowding out the retrieval context.
 *
 * Collapses repeats of the same `chosen_hts` to their first (highest-similarity,
 * since the RPC returns rows distance-ordered) occurrence. Auto-persist writes a
 * row per classification with no dedup, so an importer who re-submits the same
 * product would otherwise see all `PRECEDENT_K` slots filled by one code — an echo
 * chamber that crowds out genuinely diverse history. Deduping by code keeps the
 * precedent window representative. (This does not bound table growth — see the
 * persist path's note; retention/dedup-on-write is deferred as a residual risk.)
 */
export function formatPrecedent(matches: PrecedentMatch[]): string {
  if (matches.length === 0) return "";
  const seenCodes = new Set<string>();
  const lines: string[] = [];
  for (const m of matches) {
    const code = sanitizeLine(m.chosen_hts).slice(0, 24);
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);
    const desc = trimTo(m.product_description, 120) || "(no description)";
    const conf =
      m.confidence != null ? ` (confidence ${m.confidence.toFixed(2)})` : "";
    lines.push(`- "${desc}" → HTS ${code}${conf}`);
  }
  return lines.join("\n");
}

/**
 * Build the decision-of-record persisted after a classification. The persisted
 * decision is the agent's RECOMMENDED candidate (`recommendation.hts_code`) with
 * that candidate's confidence and GRI reasoning — the "one to defend" the broker
 * is handed. (When U8 adds an explicit broker-confirmation step it can override
 * which candidate is written; until then the recommendation is the decision.)
 * `user_id` is stamped from the verified principal so the RLS INSERT policy
 * (`user_id = auth.uid()`) accepts the row.
 */
export function toDecisionRecord(
  tenant: TenantContext,
  productDescription: string,
  result: ClassificationResult,
  embedding: number[],
): DecisionRecord {
  const chosenHts = result.recommendation.hts_code;
  const recommended = result.candidates.find((c) => c.hts_code === chosenHts);
  return {
    importer_id: tenant.importerId,
    user_id: tenant.principal.userId,
    product_description: productDescription,
    product_embedding: embedding,
    chosen_hts: chosenHts,
    confidence: recommended?.confidence ?? null,
    reasoning: recommended?.reasoning ?? result.recommendation.why ?? null,
  };
}

// ── I/O seam ─────────────────────────────────────────────────────────────────

/** Embed one query string into its vector. */
export type EmbedFn = (text: string) => Promise<number[]>;
/** Similarity-search a single importer's history (RLS-scoped). */
export type SearchFn = (
  importerId: string,
  embedding: number[],
  k: number,
) => Promise<PrecedentMatch[]>;
/** Persist one decision (RLS validates importer membership + authorship). */
export type InsertFn = (record: DecisionRecord) => Promise<void>;

export interface MemoryDeps {
  embed: EmbedFn;
  search: SearchFn;
  insert: InsertFn;
}

const MATCH_RPC = "match_classifications";
const TABLE = "classifications";

/** Default embed: one vector via the gateway (KTD9), reusing the U4/U5 client. */
const defaultEmbed: EmbedFn = async (text) => (await embedTexts([text]))[0];

/** Default search: the `match_classifications` RPC via the AUTHENTICATED client
 *  (RLS-scoped — see the module header). Non-array data degrades to "no matches". */
const defaultSearch: SearchFn = async (importerId, embedding, k) => {
  const client = await getServerClient();
  const { data, error } = await client.database.rpc(MATCH_RPC, {
    query_embedding: embedding,
    target_importer: importerId,
    match_count: k,
  });
  if (error) {
    throw new Error(`[memory] ${MATCH_RPC} failed: ${error.message ?? String(error)}`);
  }
  if (!Array.isArray(data)) return [];
  return data
    .map((r) => toPrecedentMatch(r))
    .filter((m): m is PrecedentMatch => m !== null);
};

/** Default insert: through the AUTHENTICATED client so the RLS INSERT policy
 *  ("members insert own decisions") validates membership + authorship. */
const defaultInsert: InsertFn = async (record) => {
  const client = await getServerClient();
  const { error } = await client.database.from(TABLE).insert([record]);
  if (error) {
    throw new Error(
      `[memory] persist decision failed: ${error.message ?? String(error)}`,
    );
  }
};

/**
 * A per-request memory instance. `createMemory` is called once per classification
 * (inside the agent's `RunAgent` closure) so the embedding memoization below is
 * scoped to a single request and never grows across requests.
 */
export interface Memory {
  /** Prior decisions for this importer, formatted for the system-prompt hook.
   *  Returns "" for a blank query or an importer with no (similar-enough) history. */
  fetchPrecedent: (importerId: string, query: string) => Promise<string>;
  /** Persist the recommended decision-of-record for later precedent. No-op on a
   *  blank query. NOTE (residual risk): writes are unconditional — no dedup or
   *  retention cap — so an importer's history grows one row per classification.
   *  Acceptable at demo scale (U11 rate-limits request volume; the free-tier cap
   *  pressure is the shared corpus, not this table), and precedent QUALITY is
   *  protected by `formatPrecedent`'s per-code dedup. A production system would
   *  add dedup-on-write / retention; deferred intentionally. */
  persistDecision: (
    tenant: TenantContext,
    query: string,
    result: ClassificationResult,
  ) => Promise<void>;
}

/**
 * Wire a request-scoped memory over its I/O deps (all defaulting to the real
 * gateway + authenticated client, all overridable for tests). The product
 * description is embedded at most ONCE per request: the same vector powers both
 * the precedent search and, if the request persists, the stored decision — so
 * `fetchPrecedent` + `persistDecision` for the same query never double-embed.
 */
export function createMemory(overrides: Partial<MemoryDeps> = {}): Memory {
  const embed = overrides.embed ?? defaultEmbed;
  const search = overrides.search ?? defaultSearch;
  const insert = overrides.insert ?? defaultInsert;

  // Memoize by exact query text; both methods below key off the same string.
  const embedCache = new Map<string, Promise<number[]>>();
  const embedOnce = (text: string): Promise<number[]> => {
    let pending = embedCache.get(text);
    if (!pending) {
      pending = embed(text);
      // Evict a REJECTED embedding so a transient failure during the precedent
      // read doesn't also doom the later persist to the same cached rejection —
      // persist gets a fresh attempt. A resolved embedding stays cached (the
      // whole point: fetch + persist for one query embed at most once).
      pending.catch(() => embedCache.delete(text));
      embedCache.set(text, pending);
    }
    return pending;
  };

  return {
    fetchPrecedent(importerId, query) {
      const q = query.trim();
      if (!q) return Promise.resolve("");
      // Bounded so a hung gateway/DB can't stall synthesis; on timeout the caller
      // degrades to no precedent (best-effort).
      return withTimeout(
        (async () => {
          const embedding = await embedOnce(q);
          const matches = await search(importerId, embedding, PRECEDENT_K);
          const relevant = matches.filter(
            (m) => m.similarity >= PRECEDENT_MIN_SIMILARITY,
          );
          return formatPrecedent(relevant);
        })(),
        MEMORY_TIMEOUT_MS,
        "precedent lookup",
      );
    },

    persistDecision(tenant, query, result) {
      const q = query.trim();
      if (!q) return Promise.resolve();
      // Bounded so a hung insert can't stall the response after synthesis; on
      // timeout the decision is simply not recorded (best-effort).
      return withTimeout(
        (async () => {
          const embedding = await embedOnce(q);
          await insert(toDecisionRecord(tenant, q, result, embedding));
        })(),
        MEMORY_TIMEOUT_MS,
        "decision persist",
      );
    },
  };
}
