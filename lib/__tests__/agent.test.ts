import { describe, expect, it, vi } from "vitest";

import {
  buildSystemPrompt,
  collectRetrievedChunkIds,
  collectWebUrls,
  createRunAgent,
  deriveSourcesUsed,
  normalizeMessages,
  runClassification,
  validateCandidateCitations,
  RETRIEVE_TOOL,
  WEB_SEARCH_TOOL,
  type GenerateFn,
  type RetrievedChunkMeta,
  type RetrievedIndex,
  type StepLike,
} from "@/lib/agent";
import type { Candidate, Citation, Classification } from "@/lib/schema";
import type { TenantContext } from "@/lib/auth";

/**
 * U6's defensibility guarantees, proven without a live model. The model call is
 * an injected `generate`, so `runClassification`'s server-side verification —
 * sources derived from real tool results, citations constrained to retrieved
 * chunk ids — is exercised deterministically. The pure helpers are tested
 * directly for the underlying scenarios.
 */

// ── builders ─────────────────────────────────────────────────────────────────

function corpusCitation(chunk_id: number | null): Citation {
  return {
    source: "corpus",
    chunk_id,
    hts_code: "6109.10.0012",
    ruling_number: null,
    gri_rule: null,
    url: null,
    title: null,
  };
}
function webCitation(url: string | null): Citation {
  return {
    source: "web",
    chunk_id: null,
    hts_code: null,
    ruling_number: null,
    gri_rule: null,
    url,
    title: "trade update",
  };
}
function candidate(citations: Citation[]): Candidate {
  return {
    hts_code: "6109.10.0012",
    reasoning: "GRI 1 applies.",
    citations,
    confidence: 0.7,
  };
}
function classification(candidates: Candidate[]): Classification {
  return {
    candidates,
    recommendation: { hts_code: candidates[0].hts_code, why: "best fit" },
    why_not: [
      { hts_code: "a", why: "no" },
      { hts_code: "b", why: "no" },
    ],
  };
}
/** A retrieve tool result step, shaped like the AI SDK's `StepResult`. */
function retrieveStep(ids: number[]): StepLike {
  return {
    toolResults: [
      {
        toolName: RETRIEVE_TOOL,
        output: { count: ids.length, chunks: ids.map((id) => ({ id })) },
      },
    ],
  };
}
function webStep(urls: string[]): StepLike {
  return {
    toolResults: [
      {
        toolName: WEB_SEARCH_TOOL,
        output: {
          count: urls.length,
          untrusted: true,
          results: urls.map((url) => ({ title: "t", url, content: "c" })),
        },
      },
    ],
  };
}
/** A retrieved-evidence allow-list for validateCandidateCitations unit tests. */
function index(
  chunks: Array<[number, RetrievedChunkMeta]> | number[],
  urls: string[] = [],
): RetrievedIndex {
  const entries: Array<[number, RetrievedChunkMeta]> = chunks.map((c) =>
    typeof c === "number" ? [c, {}] : c,
  );
  return { chunks: new Map(entries), urls: new Set(urls) };
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("states the core defensibility constraints", () => {
    const p = buildSystemPrompt();
    expect(p).toContain("GRI");
    expect(p).toContain("EXACTLY three");
    expect(p).toContain("chunk_id");
    expect(p).toContain("untrusted");
    expect(p).toContain(RETRIEVE_TOOL);
    expect(p).toContain(WEB_SEARCH_TOOL);
  });

  it("injects importer precedent when provided (the U7 hook) and omits it otherwise", () => {
    expect(buildSystemPrompt()).not.toContain("Prior classifications");
    const withPrecedent = buildSystemPrompt({ precedent: "0101.21 — live horses" });
    expect(withPrecedent).toContain("Prior classifications");
    expect(withPrecedent).toContain("live horses");
  });
});

describe("collectRetrievedChunkIds", () => {
  it("unions ids across multiple retrieve calls and dedupes", () => {
    const ids = collectRetrievedChunkIds([retrieveStep([1, 2]), retrieveStep([2, 3])]);
    expect([...ids].sort()).toEqual([1, 2, 3]);
  });

  it("ignores non-retrieve tools and malformed rows", () => {
    const step: StepLike = {
      toolResults: [
        { toolName: WEB_SEARCH_TOOL, output: { results: [{ url: "u" }] } },
        { toolName: RETRIEVE_TOOL, output: { chunks: [{ id: 5 }, { id: "x" }] } },
        { toolName: RETRIEVE_TOOL, output: { chunks: null } },
      ],
    };
    expect([...collectRetrievedChunkIds([step])]).toEqual([5]);
  });
});

describe("collectWebUrls", () => {
  it("dedupes and drops empty urls", () => {
    expect(collectWebUrls([webStep(["https://a", "https://a", ""])])).toEqual([
      "https://a",
    ]);
  });
});

describe("deriveSourcesUsed", () => {
  it("AE1: corpus-only when only retrieve returned evidence", () => {
    const s = deriveSourcesUsed([retrieveStep([10, 11])]);
    expect(s).toEqual({
      corpus: true,
      web: false,
      corpus_chunk_ids: [10, 11],
      web_urls: [],
    });
  });

  it("AE2: marks web used when web search returned results", () => {
    const s = deriveSourcesUsed([retrieveStep([10]), webStep(["https://ustr.gov"])]);
    expect(s.corpus).toBe(true);
    expect(s.web).toBe(true);
    expect(s.web_urls).toEqual(["https://ustr.gov"]);
  });

  it("reports web:false when web search returned nothing (outage/degraded)", () => {
    expect(deriveSourcesUsed([retrieveStep([1]), webStep([])]).web).toBe(false);
  });

  it("reports both false when no tool returned evidence", () => {
    expect(deriveSourcesUsed([])).toEqual({
      corpus: false,
      web: false,
      corpus_chunk_ids: [],
      web_urls: [],
    });
  });
});

describe("validateCandidateCitations", () => {
  it("keeps corpus citations whose chunk_id was retrieved, drops the rest", () => {
    const { candidates, dropped } = validateCandidateCitations(
      [candidate([corpusCitation(1), corpusCitation(999), corpusCitation(null)])],
      index([1, 2]),
    );
    expect(candidates[0].citations.map((c) => c.chunk_id)).toEqual([1]);
    expect(dropped).toBe(2);
  });

  it("drops a corpus citation whose claimed code contradicts the retrieved chunk (content fidelity)", () => {
    const good: Citation = { ...corpusCitation(5), hts_code: "6109.10.0012" };
    const bad: Citation = { ...corpusCitation(5), hts_code: "9999.99.9999" };
    const { candidates, dropped } = validateCandidateCitations(
      [candidate([good, bad])],
      index([[5, { hts_code: "6109.10.0012" }]]),
    );
    expect(candidates[0].citations).toHaveLength(1);
    expect(candidates[0].citations[0].hts_code).toBe("6109.10.0012");
    expect(dropped).toBe(1);
  });

  it("keeps only web citations whose url was actually returned by web search", () => {
    const { candidates, dropped } = validateCandidateCitations(
      [
        candidate([
          webCitation("https://ustr.gov/301"),
          webCitation("https://fabricated.example"),
          webCitation(null),
        ]),
      ],
      index([], ["https://ustr.gov/301"]),
    );
    expect(candidates[0].citations.map((c) => c.url)).toEqual(["https://ustr.gov/301"]);
    expect(dropped).toBe(2);
  });
});

describe("normalizeMessages", () => {
  it("wraps a bare string as a user message", () => {
    expect(normalizeMessages("cotton t-shirt")).toEqual([
      { role: "user", content: "cotton t-shirt" },
    ]);
  });

  it("passes through already-model messages", () => {
    const msgs = [{ role: "user", content: "hi" }];
    expect(normalizeMessages(msgs)).toBe(msgs);
  });

  it("converts useChat UI messages via convertToModelMessages", () => {
    const ui = [{ role: "user", parts: [{ type: "text", text: "silk scarf" }] }];
    const result = normalizeMessages(ui);
    expect(result[0].role).toBe("user");
    expect(JSON.stringify(result)).toContain("silk scarf");
  });

  it("rejects empty input loudly", () => {
    expect(() => normalizeMessages("   ")).toThrow();
    expect(() => normalizeMessages([])).toThrow();
  });
});

// ── orchestration (fake model) ───────────────────────────────────────────────

/** A fake `generate` returning canned output + steps, capturing its args. */
function fakeGenerate(output: Classification, steps: StepLike[]): GenerateFn {
  return vi.fn(async () => ({ output, steps }));
}

describe("runClassification", () => {
  const tools = {} as never;

  it("AE1: a corpus-covered product reports corpus-only sources and keeps its citations", async () => {
    const output = classification([
      candidate([corpusCitation(10)]),
      candidate([corpusCitation(11)]),
      candidate([corpusCitation(10)]),
    ]);
    const generate = fakeGenerate(output, [retrieveStep([10, 11])]);

    const result = await runClassification(
      { messages: "cotton t-shirt" },
      { tools, generate },
    );

    expect(result.sources_used).toEqual({
      corpus: true,
      web: false,
      corpus_chunk_ids: [10, 11],
      web_urls: [],
    });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].citations[0].chunk_id).toBe(10);
  });

  it("AE2: a currency-gap product surfaces the web source alongside corpus", async () => {
    const output = classification([
      candidate([corpusCitation(10), webCitation("https://ustr.gov/301")]),
      candidate([corpusCitation(10)]),
      candidate([corpusCitation(10)]),
    ]);
    const generate = fakeGenerate(output, [
      retrieveStep([10]),
      webStep(["https://ustr.gov/301"]),
    ]);

    const result = await runClassification({ messages: "novel product" }, { tools, generate });

    expect(result.sources_used.web).toBe(true);
    expect(result.sources_used.web_urls).toEqual(["https://ustr.gov/301"]);
    expect(result.candidates[0].citations.some((c) => c.source === "web")).toBe(true);
  });

  it("integration: drops a fabricated chunk_id the model never retrieved (KTD11)", async () => {
    const output = classification([
      candidate([corpusCitation(10), corpusCitation(777)]), // 777 was never retrieved
      candidate([corpusCitation(10)]),
      candidate([corpusCitation(10)]),
    ]);
    const generate = fakeGenerate(output, [retrieveStep([10])]);

    const result = await runClassification({ messages: "widget" }, { tools, generate });

    const ids = result.candidates[0].citations.map((c) => c.chunk_id);
    expect(ids).toEqual([10]);
    expect(ids).not.toContain(777);
  });

  it("rejects a classification whose candidate loses all corpus backing (web-only is indefensible)", async () => {
    // The model cites a fabricated corpus id (dropped) plus a valid web url — so
    // after validation candidate 1 is backed ONLY by untrusted web. Must fail loud.
    const output = classification([
      candidate([corpusCitation(777), webCitation("https://ustr.gov")]),
      candidate([corpusCitation(10)]),
      candidate([corpusCitation(10)]),
    ]);
    const generate = fakeGenerate(output, [
      retrieveStep([10]),
      webStep(["https://ustr.gov"]),
    ]);

    await expect(
      runClassification({ messages: "x" }, { tools, generate }),
    ).rejects.toThrow(/corpus-backed/);
  });

  it("passes the constrained system prompt and normalized messages to the model", async () => {
    const output = classification([
      candidate([corpusCitation(1)]),
      candidate([corpusCitation(1)]),
      candidate([corpusCitation(1)]),
    ]);
    const generate = fakeGenerate(output, [retrieveStep([1])]);

    await runClassification({ messages: "silk scarf" }, { tools, generate });

    const args = (generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.system).toContain("chunk_id");
    expect(args.messages).toEqual([{ role: "user", content: "silk scarf" }]);
    expect(args.maxSteps).toBeGreaterThan(0);
  });
});

// ── createRunAgent: the wired entry point (success + error mapping) ───────────

const TENANT: TenantContext = {
  principal: { userId: "broker-1", email: "b@example.com" },
  importerId: "imp-1",
  memberships: ["imp-1"],
};

describe("createRunAgent", () => {
  const validOutput = classification([
    candidate([corpusCitation(1)]),
    candidate([corpusCitation(1)]),
    candidate([corpusCitation(1)]),
  ]);
  const validSteps = [retrieveStep([1])];

  it("returns 200 with the validated classification on success", async () => {
    const runAgent = createRunAgent({
      tools: {},
      generate: fakeGenerate(validOutput, validSteps),
    });

    const res = await runAgent({ messages: "cotton t-shirt", tenant: TENANT });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidates).toHaveLength(3);
    expect(body.sources_used.corpus).toBe(true);
  });

  it("maps malformed input to 400, not the 502 model-failure shape", async () => {
    const runAgent = createRunAgent({
      tools: {},
      generate: fakeGenerate(validOutput, validSteps),
    });

    const res = await runAgent({ messages: "   ", tenant: TENANT });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("returns a flagged 502 on model failure WITHOUT leaking the error detail", async () => {
    const generate = vi.fn(async () => {
      throw new Error("gateway exploded: sensitive-internal-detail");
    });
    const runAgent = createRunAgent({ tools: {}, generate });

    const res = await runAgent({ messages: "x", tenant: TENANT });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: "classification_failed", degraded: true });
    expect(JSON.stringify(body)).not.toContain("sensitive-internal-detail");
  });
});
