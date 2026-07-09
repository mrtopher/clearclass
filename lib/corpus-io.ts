/**
 * Shared I/O helpers for the offline corpus-ingestion scripts (U2–U4).
 *
 * The ingest scripts each produce a JSONL corpus artifact and each fetches from
 * a flaky external source, so the atomic-write and fetch-with-retry patterns are
 * identical across them. Factoring them here keeps the loud-failure contract
 * (atomic temp+rename; bounded retry with backoff) consistent and in one place
 * rather than re-derived per script.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
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

/** Per-request timeout — Node's global fetch has none, so a hung socket would otherwise stall a run forever. */
const FETCH_TIMEOUT_MS = 30_000;
const MAX_FETCH_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch `url` with a timeout and bounded exponential backoff, then run `parse`
 * on the successful response. A non-OK HTTP status or a `parse` throw is retried
 * up to `MAX_FETCH_ATTEMPTS`; the final failure throws with `label` for context.
 */
export async function fetchWithRetry<T>(
  url: string,
  label: string,
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json", "User-Agent": "ClearClass-ingest/1.0" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${label}`);
      return await parse(res);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        const backoffMs = 500 * 2 ** (attempt - 1);
        console.warn(
          `[ingest] ${label} attempt ${attempt} failed: ${(err as Error).message} — retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs);
      }
    }
  }
  throw new Error(
    `[ingest] ${label} failed after ${MAX_FETCH_ATTEMPTS} attempts: ${(lastError as Error).message}`,
  );
}
