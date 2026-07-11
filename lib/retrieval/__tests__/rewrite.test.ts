import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRewritePrompt,
  composeQuery,
  DEFAULT_QUERY_REWRITE_MODE,
  MAX_REWRITE_CHARS,
  resolveQueryRewrite,
  rewriteQuery,
  withQueryRewrite,
  type RewriteFn,
} from "@/lib/retrieval/rewrite";
import type { DenseRetriever, RetrievedChunk } from "@/lib/retrieval/dense";

/**
 * The query-rewrite lever's contract: transform the query toward tariff-line
 * phrasing before retrieval, BUT never crash and never retrieve on an empty query
 * — any rewrite failure (outage, missing key, timeout, empty output) degrades to
 * the ORIGINAL query so retrieval is never worse than the un-rewritten baseline.
 * Pure orchestration over an injected `RewriteFn` — no network, no key.
 */

describe("resolveQueryRewrite", () => {
  afterEach(() => {
    delete process.env.QUERY_REWRITE;
  });

  it("defaults to off (the safe baseline) when unset or blank", () => {
    expect(resolveQueryRewrite(undefined)).toBe("off");
    expect(resolveQueryRewrite("")).toBe("off");
    expect(resolveQueryRewrite("  ")).toBe("off");
    expect(DEFAULT_QUERY_REWRITE_MODE).toBe("off");
  });

  it("maps explicit off-aliases to off", () => {
    for (const v of ["off", "false", "0", "baseline", "OFF", " Off "]) {
      expect(resolveQueryRewrite(v)).toBe("off");
    }
  });

  it("maps bare on-aliases to expand (the lower-variance strategy)", () => {
    for (const v of ["on", "true", "1", "expand", "EXPAND"]) {
      expect(resolveQueryRewrite(v)).toBe("expand");
    }
  });

  it("recognizes hyde explicitly", () => {
    expect(resolveQueryRewrite("hyde")).toBe("hyde");
    expect(resolveQueryRewrite(" HYDE ")).toBe("hyde");
  });

  it("falls back to off (with a warn) on an unrecognized value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveQueryRewrite("banana")).toBe("off");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("reads process.env.QUERY_REWRITE when no arg is passed", () => {
    process.env.QUERY_REWRITE = "hyde";
    expect(resolveQueryRewrite()).toBe("hyde");
  });
});

describe("buildRewritePrompt", () => {
  it("embeds the trimmed query under a clear rewrite instruction", () => {
    const p = buildRewritePrompt("  cotton knit shirt  ");
    expect(p).toContain("cotton knit shirt");
    expect(p).not.toMatch(/ {2}cotton/); // trimmed
    expect(p).toMatch(/tariff-style/i);
  });
});

describe("composeQuery", () => {
  it("hyde returns the rewrite alone", () => {
    expect(composeQuery("orig", "tariff phrasing", "hyde")).toBe("tariff phrasing");
  });

  it("expand joins the original (first) and the rewrite", () => {
    expect(composeQuery("orig", "tariff phrasing", "expand")).toBe("orig\ntariff phrasing");
  });

  it("falls back to the original under BOTH strategies when the rewrite is empty", () => {
    expect(composeQuery("orig", "   ", "hyde")).toBe("orig");
    expect(composeQuery("orig", "", "expand")).toBe("orig");
  });
});

describe("rewriteQuery", () => {
  const ok = (out: string): RewriteFn => vi.fn(async () => out);

  it("hyde retrieves on the rewrite alone", async () => {
    const out = await rewriteQuery("a stallion for breeding", "hyde", {
      rewrite: ok("Live horses; purebred breeding animals"),
    });
    expect(out).toBe("Live horses; purebred breeding animals");
  });

  it("expand keeps the original terms and appends the rewrite", async () => {
    const out = await rewriteQuery("stallion", "expand", {
      rewrite: ok("Live horses; purebred breeding animals"),
    });
    expect(out).toBe("stallion\nLive horses; purebred breeding animals");
  });

  it("passes the TRIMMED query to the rewrite fn", async () => {
    const rewrite = ok("x");
    await rewriteQuery("  padded query  ", "hyde", { rewrite });
    expect(rewrite).toHaveBeenCalledWith("padded query");
  });

  it("caps a runaway rewrite at MAX_REWRITE_CHARS", async () => {
    const long = "z".repeat(MAX_REWRITE_CHARS + 50);
    const out = await rewriteQuery("q", "hyde", { rewrite: ok(long) });
    expect(out.length).toBe(MAX_REWRITE_CHARS);
  });

  it("returns the original query WITHOUT calling the rewrite fn for a blank query", async () => {
    const rewrite = ok("x");
    expect(await rewriteQuery("   ", "hyde", { rewrite })).toBe("   ");
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("degrades to the original query when the rewrite THROWS — no crash", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await rewriteQuery("cotton shirt", "hyde", {
      rewrite: vi.fn(async () => {
        throw new Error("gateway 503");
      }),
    });
    expect(out).toBe("cotton shirt");
    warn.mockRestore();
  });

  it("degrades to the original query when the rewrite is empty/whitespace", async () => {
    expect(await rewriteQuery("cotton shirt", "expand", { rewrite: ok("   ") })).toBe("cotton shirt");
  });

  it("fires onFallback exactly once when the rewrite THROWS", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onFallback = vi.fn();
    await rewriteQuery("q", "hyde", {
      rewrite: vi.fn(async () => {
        throw new Error("timeout");
      }),
      onFallback,
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("fires onFallback when the rewrite is empty", async () => {
    const onFallback = vi.fn();
    await rewriteQuery("q", "hyde", { rewrite: ok(""), onFallback });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire onFallback on a successful rewrite", async () => {
    const onFallback = vi.fn();
    await rewriteQuery("q", "hyde", { rewrite: ok("tariff phrasing"), onFallback });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("does NOT fire onFallback for the blank-query early return", async () => {
    const onFallback = vi.fn();
    await rewriteQuery("   ", "hyde", { rewrite: ok("x"), onFallback });
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("withQueryRewrite", () => {
  const chunk = (id: number): RetrievedChunk => ({
    id,
    content: `chunk ${id}`,
    type: "hts",
    metadata: {},
    similarity: 0.5,
  });

  it("returns the retriever UNCHANGED (same reference) when mode is off", () => {
    const base: DenseRetriever = vi.fn(async () => [chunk(1)]);
    const wrapped = withQueryRewrite(base, "off", { rewrite: vi.fn() });
    expect(wrapped).toBe(base);
  });

  it("rewrites the query before delegating, preserving opts", async () => {
    const base = vi.fn(async () => [chunk(1)]);
    const wrapped = withQueryRewrite(base, "hyde", {
      rewrite: async () => "tariff phrasing",
    });
    await wrapped("stallion", { k: 5, type: "hts" });
    expect(base).toHaveBeenCalledWith("tariff phrasing", { k: 5, type: "hts" });
  });

  it("still retrieves (on the original query) when the rewrite fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = vi.fn(async () => [chunk(1)]);
    const wrapped = withQueryRewrite(base, "expand", {
      rewrite: async () => {
        throw new Error("down");
      },
    });
    const out = await wrapped("cotton shirt");
    expect(base).toHaveBeenCalledWith("cotton shirt", {});
    expect(out.map((c) => c.id)).toEqual([1]);
    warn.mockRestore();
  });
});
