/**
 * Shared I/O helpers for the offline corpus-ingestion scripts (U2–U4).
 *
 * The ingest scripts each produce a JSONL corpus artifact and each fetches from
 * a flaky external source, so the atomic-write and fetch-with-retry patterns are
 * identical across them. Factoring them here keeps the loud-failure contract
 * (atomic temp+rename; bounded retry with backoff) consistent and in one place
 * rather than re-derived per script.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write records as JSONL to `absPath` atomically: stage to a temp sibling then
 * rename into place, so an interrupted write can never truncate or clobber an
 * existing good corpus. Each record is `JSON.stringify`'d onto its own line.
 */
export async function writeJsonlAtomic(
  absPath: string,
  records: readonly unknown[],
): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp`;
  const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(tmpPath, jsonl, "utf8");
  await rename(tmpPath, absPath);
}

/**
 * Read a JSONL corpus artifact written by `writeJsonlAtomic` back into records.
 * Blank lines (including the trailing newline) are skipped; a malformed line
 * throws with its line number rather than yielding a partial/undefined record,
 * so a truncated or corrupt corpus fails loudly at load time (U4).
 */
export async function readJsonl<T>(absPath: string): Promise<T[]> {
  const raw = await readFile(absPath, "utf8");
  const records: T[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (err) {
      throw new Error(
        `[corpus-io] ${absPath}:${i + 1} is not valid JSON: ${(err as Error).message}`,
      );
    }
  }
  return records;
}

const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run `op` with bounded exponential backoff. Retries any throw up to
 * `attempts`; the final failure re-throws wrapped with `label` for context.
 * Shared by the network fetch and the embed/insert load path so the
 * loud-failure-after-bounded-retry contract lives in one place.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  label: string,
  attempts: number = MAX_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        const backoffMs = 500 * 2 ** (attempt - 1);
        // No module prefix here — `withRetry` is shared, so the caller's `label`
        // carries the context (e.g. "insert 64 rows into documents"). A hardcoded
        // prefix would misattribute retries across the ingest/embed-load paths.
        console.warn(
          `[retry] ${label} attempt ${attempt} failed: ${(err as Error).message} — retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
      }
    }
  }
  throw new Error(
    `${label} failed after ${attempts} attempts: ${(lastError as Error).message}`,
  );
}

/** Per-request timeout — Node's global fetch has none, so a hung socket would otherwise stall a run forever. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Fetch `url` with a timeout and bounded exponential backoff, then run `parse`
 * on the successful response. A non-OK HTTP status or a `parse` throw is retried;
 * the final failure throws with `label` for context.
 */
export async function fetchWithRetry<T>(
  url: string,
  label: string,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json", "User-Agent": "ClearClass-ingest/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${label}`);
    return await parse(res);
  }, label);
}
