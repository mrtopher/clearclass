import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readJsonl, withRetry } from "@/lib/corpus-io";

/**
 * `readJsonl` and `withRetry` are the shared load-path helpers U4 relies on.
 * Both encode a loud-failure contract — a malformed line names its position,
 * and a bounded retry re-throws with context — so they are pinned here.
 */

async function tmpFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clearclass-corpus-io-"));
  const path = join(dir, "corpus.jsonl");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("readJsonl", () => {
  it("parses one record per line and skips blank lines / trailing newline", async () => {
    const path = await tmpFile('{"a":1}\n{"a":2}\n\n');
    expect(await readJsonl<{ a: number }>(path)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("throws with the 1-based line number on a malformed line", async () => {
    const path = await tmpFile('{"a":1}\nnot json\n');
    await expect(readJsonl(path)).rejects.toThrow(/corpus\.jsonl:2 is not valid JSON/);
  });
});

describe("withRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the first success without retrying", async () => {
    const op = vi.fn(() => Promise.resolve("ok"));
    expect(await withRetry(op, "op")).toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure then succeeds", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const op = vi.fn(() => {
      calls++;
      return calls < 2 ? Promise.reject(new Error("flaky")) : Promise.resolve("ok");
    });
    const promise = withRetry(op, "op");
    await vi.runAllTimersAsync();
    expect(await promise).toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });

  it("re-throws with the label after exhausting attempts", async () => {
    vi.useFakeTimers();
    const op = vi.fn(() => Promise.reject(new Error("down")));
    const promise = withRetry(op, "load batch", 3);
    const assertion = expect(promise).rejects.toThrow(/load batch failed after 3 attempts: down/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(op).toHaveBeenCalledTimes(3);
  });
});
