import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTavilySearch,
  createTavilyTool,
  MAX_CONTENT_CHARS,
  type TavilySearch,
  type TavilyToolResult,
  type WebResult,
} from "@/lib/tools/tavily";

/**
 * The web-search tool must (a) faithfully surface results as UNTRUSTED, and
 * (b) NEVER crash the agent loop — a search outage or missing key degrades to an
 * empty, flagged result so classification continues corpus-only (the U6 error
 * scenario). Tests inject a fake `TavilySearch` — no network, no key.
 */

const results: WebResult[] = [
  { title: "2026 Section 301 update", url: "https://ustr.gov/301", content: "..." },
];

// The AI SDK passes a ToolCallOptions second arg at runtime; tests don't need it.
const opts = {} as never;

describe("createTavilyTool", () => {
  it("returns results from the injected search, marked untrusted", async () => {
    const search: TavilySearch = vi.fn(async () => results);
    const tool = createTavilyTool(search);

    const out = (await tool.execute!({ query: "recent tariff change", max_results: 3 }, opts)) as TavilyToolResult;

    expect(search).toHaveBeenCalledWith("recent tariff change", { maxResults: 3 });
    expect(out.count).toBe(1);
    expect(out.results[0].url).toBe("https://ustr.gov/301");
    expect(out.untrusted).toBe(true);
    expect(out.error).toBeUndefined();
  });

  it("degrades gracefully when the search transport throws (no crash)", async () => {
    const search: TavilySearch = vi.fn(async () => {
      throw new Error("tavily 503");
    });
    const tool = createTavilyTool(search);

    const out = (await tool.execute!({ query: "anything" }, opts)) as TavilyToolResult;

    expect(out.count).toBe(0);
    expect(out.results).toEqual([]);
    expect(out.untrusted).toBe(true);
    expect(out.error).toContain("tavily 503");
  });

  it("short-circuits a blank query without hitting the transport", async () => {
    const search = vi.fn<TavilySearch>(async () => results);
    const tool = createTavilyTool(search);

    const out = (await tool.execute!({ query: "   " }, opts)) as TavilyToolResult;

    expect(out).toEqual({ count: 0, results: [], untrusted: true });
    expect(search).not.toHaveBeenCalled();
  });

  it("defaults max_results when the model omits it", async () => {
    const search: TavilySearch = vi.fn(async () => results);
    const tool = createTavilyTool(search);

    await tool.execute!({ query: "x" }, opts);

    expect(search).toHaveBeenCalledWith("x", { maxResults: 5 });
  });
});

/**
 * The real HTTP transport (mirrors the createFetchSearch coverage in
 * lib/retrieval/__tests__/dense.test.ts): key handling, request shape, the
 * abort-timeout, error propagation, and the content cap that bounds the
 * untrusted-input surface. `fetch` and the env key are stubbed — no network.
 */
describe("createTavilySearch (transport)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("throws when TAVILY_API_KEY is unset (so the tool degrades to corpus-only)", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    await expect(createTavilySearch()("q", { maxResults: 3 })).rejects.toThrow(/TAVILY_API_KEY/);
  });

  it("posts key+query, passes an abort signal, and caps result content", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const longContent = "x".repeat(MAX_CONTENT_CHARS + 500);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ results: [{ title: "t", url: "https://a", content: longContent }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await createTavilySearch()("recent tariff", { maxResults: 4 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("tavily.com");
    expect(JSON.parse(init.body as string)).toMatchObject({
      api_key: "tvly-test",
      query: "recent tariff",
      max_results: 4,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(out[0].content.length).toBe(MAX_CONTENT_CHARS);
  });

  it("throws on a non-OK response", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" })),
    );
    await expect(createTavilySearch()("q", { maxResults: 3 })).rejects.toThrow(/429/);
  });
});
