import { describe, expect, it, vi } from "vitest";

import {
  buildSystemPrompt,
  candidateSupportRank,
  collectRetrievedChunkIds,
  collectRetrievedChunks,
  collectWebUrls,
  deriveSourcesUsed,
  latestUserText,
  normalizeMessages,
  reselectByRetrievalSupport,
  resolveReselect,
  runClassification,
  validateCandidateCitations,
  RETRIEVE_TOOL,
  WEB_SEARCH_TOOL,
  type GenerateFn,
  type RankedClassification,
  type RetrievedChunkMeta,
  type RetrievedIndex,
  type StepLike,
} from "@/lib/agent";
import { createRunAgent } from "@/lib/run-agent";
import type { MemoryDeps } from "@/lib/memory";
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

  it("mentions JSON and specifies the exact output shape (gateway json_object requirement)", () => {
    // Regression guard for the live-gateway bug: `experimental_output` runs the
    // OpenAI-compatible provider in `json_object` mode, which (a) 400s unless the
    // prompt contains the word "json", and (b) does NOT send the schema to the
    // model — so the prompt must spell out the exact field names or the model
    // free-forms the wrong shape (e.g. "recommended" string, why_not as a map,
    // no citations) and Zod validation rejects it. Neither is caught by the
    // fake-`generate` tests, so this locks the prompt contract in place.
    const p = buildSystemPrompt().toLowerCase();
    expect(p).toContain("json");
    // The exact schema key names the model must emit.
    expect(p).toContain("candidates");
    expect(p).toContain("citations");
    expect(p).toContain('"recommendation"');
    expect(p).toContain('"why_not"');
  });

  it("injects importer precedent when provided (the U7 hook) and omits it otherwise", () => {
    expect(buildSystemPrompt()).not.toContain("Prior classifications");
    const withPrecedent = buildSystemPrompt({ precedent: "0101.21 — live horses" });
    expect(withPrecedent).toContain("Prior classifications");
    expect(withPrecedent).toContain("live horses");
    // Precedent is delimited and framed as untrusted stored data, like web content.
    expect(withPrecedent).toContain("<precedent>");
    expect(withPrecedent).toContain("NOT instructions");
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

describe("latestUserText", () => {
  it("reads a plain-string user turn", () => {
    expect(latestUserText([{ role: "user", content: "cotton t-shirt" }])).toBe(
      "cotton t-shirt",
    );
  });

  it("joins the text parts of a useChat-style user turn", () => {
    expect(
      latestUserText([
        {
          role: "user",
          content: [
            { type: "text", text: "silk" },
            { type: "text", text: "scarf" },
          ],
        },
      ] as never),
    ).toBe("silk scarf");
  });

  it("returns the LATEST user turn, ignoring assistant turns", () => {
    expect(
      latestUserText([
        { role: "user", content: "first" },
        { role: "assistant", content: "..." },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
  });

  it("returns '' when there is no user text (memory treats it as no-op)", () => {
    expect(latestUserText([{ role: "assistant", content: "hi" }])).toBe("");
    expect(latestUserText([])).toBe("");
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

// ── Task 6.3: retrieval-support re-selection ─────────────────────────────────

/** A retrieve step carrying explicit similarity per chunk (rank = array index). */
function retrieveStepScored(chunks: Array<{ id: number; similarity?: number }>): StepLike {
  return {
    toolResults: [
      { toolName: RETRIEVE_TOOL, output: { count: chunks.length, chunks } },
    ],
  };
}
/** A candidate at `code`, whose corpus citations point at the given chunk ids. */
function candFor(code: string, chunkIds: number[]): Candidate {
  return {
    hts_code: code,
    reasoning: `reasoning-${code}`,
    citations: chunkIds.map((id) => ({ ...corpusCitation(id), hts_code: code })),
    confidence: 0.5,
  };
}
function ranksMap(entries: Array<[number, number]>): Map<number, RetrievedChunkMeta> {
  return new Map(entries.map(([id, rank]) => [id, { rank }]));
}

describe("collectRetrievedChunks (rank capture)", () => {
  it("records position among valid rows as rank (0 = top)", () => {
    const m = collectRetrievedChunks([retrieveStepScored([{ id: 10 }, { id: 11 }])]);
    expect(m.get(10)?.rank).toBe(0);
    expect(m.get(11)?.rank).toBe(1);
  });

  it("keeps the BEST (smallest) rank across calls", () => {
    const m = collectRetrievedChunks([
      retrieveStepScored([{ id: 7 }, { id: 8 }, { id: 9 }]), // 9 @ rank 2
      retrieveStepScored([{ id: 9 }]), //                        9 @ rank 0
    ]);
    expect(m.get(9)?.rank).toBe(0);
  });

  it("skips an id-less row without shifting later rows' ranks", () => {
    const step: StepLike = {
      toolResults: [
        { toolName: RETRIEVE_TOOL, output: { count: 3, chunks: [{ id: 4 }, { id: "x" }, { id: 5 }] } },
      ],
    };
    const m = collectRetrievedChunks([step]);
    expect(m.get(4)?.rank).toBe(0);
    expect(m.get(5)?.rank).toBe(1); // not 2 — the malformed middle row consumed no rank
  });
});

describe("candidateSupportRank", () => {
  const chunks = ranksMap([
    [10, 1],
    [20, 0],
    [50, 5],
  ]);

  it("returns the best (smallest) rank among a candidate's cited retrieved chunks", () => {
    expect(candidateSupportRank(candFor("x", [50, 20]), chunks)).toBe(0);
    expect(candidateSupportRank(candFor("x", [50, 10]), chunks)).toBe(1);
  });

  it("is +Infinity when nothing the candidate cites was retrieved (no signal)", () => {
    expect(candidateSupportRank(candFor("x", [999]), chunks)).toBe(Number.POSITIVE_INFINITY);
    const webOnly: Candidate = { ...candFor("x", []), citations: [webCitation("https://u")] };
    expect(candidateSupportRank(webOnly, chunks)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("reselectByRetrievalSupport", () => {
  const A = candFor("1111.11.1111", [20]); // rank 2
  const B = candFor("2222.22.2222", [10]); // rank 0  → should win #1
  const C = candFor("3333.33.3333", [50]); // rank 5
  const chunks = ranksMap([
    [20, 2],
    [10, 0],
    [50, 5],
  ]);
  const input: RankedClassification = {
    candidates: [A, B, C],
    recommendation: { hts_code: A.hts_code, why: "A is best" },
    why_not: [
      { hts_code: B.hts_code, why: "not B" },
      { hts_code: C.hts_code, why: "not C" },
    ],
  };

  it("re-ranks candidates by supporting-chunk rank and rebuilds a POLARITY-correct rec/why-not", () => {
    const out = reselectByRetrievalSupport(input, chunks);
    expect(out.candidates.map((c) => c.hts_code)).toEqual([B.hts_code, A.hts_code, C.hts_code]);
    // B was a *rejected* candidate ("not B"); promoted to #1 it must NOT be "defended"
    // by its own rebuttal — it gets its own positive reasoning instead.
    expect(out.recommendation).toEqual({ hts_code: B.hts_code, why: `reasoning-${B.hts_code}` });
    expect(out.recommendation.why).not.toBe("not B");
    // The demoted ex-#1 (A) has no rebuttal text → its own reasoning, not "A is best"
    // mislabeled as a rejection; C keeps its genuine rebuttal.
    expect(out.why_not).toEqual([
      { hts_code: A.hts_code, why: `reasoning-${A.hts_code}` },
      { hts_code: C.hts_code, why: "not C" },
    ]);
  });

  it("keeps the model's own defense when re-selection does NOT change the #1 pick", () => {
    // A already has the best support (rank 0) → order unchanged → keep "A is best".
    const chunksAtop = ranksMap([
      [20, 0], // A cites 20
      [10, 2], // B cites 10
      [50, 5], // C cites 50
    ]);
    const out = reselectByRetrievalSupport(input, chunksAtop);
    expect(out.candidates.map((c) => c.hts_code)).toEqual([A.hts_code, B.hts_code, C.hts_code]);
    expect(out.recommendation).toEqual({ hts_code: A.hts_code, why: "A is best" });
    expect(out.why_not).toEqual([
      { hts_code: B.hts_code, why: "not B" },
      { hts_code: C.hts_code, why: "not C" },
    ]);
  });

  it("leaves the top-3 SET unchanged — it is a permutation, so top-3 recall can't move", () => {
    const out = reselectByRetrievalSupport(input, chunks);
    expect(new Set(out.candidates.map((c) => c.hts_code))).toEqual(
      new Set(input.candidates.map((c) => c.hts_code)),
    );
  });

  it("is stable: with no retrieval signal it preserves the model's original order", () => {
    const out = reselectByRetrievalSupport(input, new Map());
    expect(out.candidates.map((c) => c.hts_code)).toEqual([A.hts_code, B.hts_code, C.hts_code]);
    expect(out.recommendation.hts_code).toBe(A.hts_code);
  });

  it("falls back to the candidate's own reasoning when no code-matching rationale exists", () => {
    const orphan: RankedClassification = {
      candidates: [A, B, C],
      recommendation: { hts_code: "zzz", why: "z" },
      why_not: [
        { hts_code: "yyy", why: "y" },
        { hts_code: "xxx", why: "x" },
      ],
    };
    const out = reselectByRetrievalSupport(orphan, chunks);
    expect(out.recommendation).toEqual({ hts_code: B.hts_code, why: `reasoning-${B.hts_code}` });
  });
});

describe("resolveReselect", () => {
  it("is off by default/empty and for explicit off-ish values", () => {
    expect(resolveReselect("")).toBe(false);
    expect(resolveReselect("off")).toBe(false);
    expect(resolveReselect("false")).toBe(false);
    expect(resolveReselect("0")).toBe(false);
  });

  it("is on for on/true/1", () => {
    expect(resolveReselect("on")).toBe(true);
    expect(resolveReselect("true")).toBe(true);
    expect(resolveReselect("1")).toBe(true);
  });

  it("warns and stays off on an unrecognized value (never silently flips the arm)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveReselect("sometimes")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("runClassification with reselect", () => {
  const tools = {} as never;
  const A = candFor("1111.11.1111", [10]);
  const B = candFor("2222.22.2222", [20]);
  const C = candFor("3333.33.3333", [50]);
  const output: Classification = {
    candidates: [A, B, C],
    recommendation: { hts_code: A.hts_code, why: "model picked A" },
    why_not: [
      { hts_code: B.hts_code, why: "not B" },
      { hts_code: C.hts_code, why: "not C" },
    ],
  };
  // Retrieved order puts B's supporting chunk (20) at the very top.
  const steps = [retrieveStep([20, 10, 50])]; // 20 @ rank 0, 10 @ rank 1, 50 @ rank 2

  it("ON: promotes the candidate whose supporting chunk retrieval ranked highest", async () => {
    const result = await runClassification(
      { messages: "x" },
      { tools, generate: fakeGenerate(output, steps), reselect: true },
    );
    expect(result.candidates.map((c) => c.hts_code)).toEqual([B.hts_code, A.hts_code, C.hts_code]);
    expect(result.recommendation.hts_code).toBe(B.hts_code);
  });

  it("OFF (default): keeps the model's own candidate order untouched", async () => {
    const off = await runClassification(
      { messages: "x" },
      { tools, generate: fakeGenerate(output, steps) },
    );
    expect(off.candidates.map((c) => c.hts_code)).toEqual([A.hts_code, B.hts_code, C.hts_code]);
    expect(off.recommendation.hts_code).toBe(A.hts_code);
  });
});

// ── createRunAgent: the wired entry point (success + error mapping) ───────────

const TENANT: TenantContext = {
  principal: { userId: "broker-1", email: "b@example.com" },
  importerId: "imp-1",
  memberships: ["imp-1"],
};

/** Hermetic memory deps: no gateway, no DB. Fakes are overridden per test. */
function fakeMemory(overrides: Partial<MemoryDeps> = {}): Partial<MemoryDeps> {
  return {
    embed: overrides.embed ?? (async () => [0.1, 0.2, 0.3]),
    search: overrides.search ?? (async () => []),
    insert: overrides.insert ?? (async () => {}),
  };
}

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
      memory: fakeMemory(),
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
      memory: fakeMemory(),
    });

    const res = await runAgent({ messages: "   ", tenant: TENANT });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("wires the Task-6.3 lever: reselect:true re-ranks the candidates at the route seam", async () => {
    const A = candFor("1111.11.1111", [10]);
    const B = candFor("2222.22.2222", [20]);
    const C = candFor("3333.33.3333", [50]);
    const output: Classification = {
      candidates: [A, B, C],
      recommendation: { hts_code: A.hts_code, why: "A" },
      why_not: [
        { hts_code: B.hts_code, why: "nb" },
        { hts_code: C.hts_code, why: "nc" },
      ],
    };
    const runAgent = createRunAgent({
      tools: {},
      generate: fakeGenerate(output, [retrieveStep([20, 10, 50])]), // 20 (B's chunk) @ rank 0
      memory: fakeMemory(),
      reselect: true,
    });

    const res = await runAgent({ messages: "x", tenant: TENANT });

    const body = await res.json();
    expect(body.candidates.map((c: { hts_code: string }) => c.hts_code)).toEqual([
      B.hts_code,
      A.hts_code,
      C.hts_code,
    ]);
    expect(body.recommendation.hts_code).toBe(B.hts_code);
  });

  it("returns a flagged 502 on model failure WITHOUT leaking the error detail", async () => {
    const generate = vi.fn(async () => {
      throw new Error("gateway exploded: sensitive-internal-detail");
    });
    const runAgent = createRunAgent({ tools: {}, generate, memory: fakeMemory() });

    const res = await runAgent({ messages: "x", tenant: TENANT });

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: "classification_failed", degraded: true });
    expect(JSON.stringify(body)).not.toContain("sensitive-internal-detail");
  });
});

// ── createRunAgent + U7 per-importer memory ──────────────────────────────────

describe("createRunAgent memory (U7)", () => {
  const validOutput = classification([
    candidate([corpusCitation(1)]),
    candidate([corpusCitation(1)]),
    candidate([corpusCitation(1)]),
  ]);
  const validSteps = [retrieveStep([1])];

  /** A precedent match row as `match_classifications` (via the search dep) returns it. */
  function precedentRow(chosen_hts: string) {
    return {
      product_description: "prior cotton shirt",
      chosen_hts,
      confidence: 0.8,
      reasoning: "GRI 1",
      similarity: 0.95,
    };
  }

  it("AE3: injects this importer's similar prior decision as precedent into the system prompt", async () => {
    const generate = fakeGenerate(validOutput, validSteps);
    const search = vi.fn(async () => [precedentRow("6109.10.0012")]);
    const runAgent = createRunAgent({
      tools: {},
      generate,
      memory: fakeMemory({ search }),
    });

    await runAgent({ messages: "cotton knit t-shirt", tenant: TENANT });

    // The system prompt handed to the model carries the precedent block.
    const args = (generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.system).toContain("Prior classifications");
    expect(args.system).toContain("6109.10.0012");
  });

  it("scopes the precedent search to the SERVER-DERIVED importer, never client input (KTD10)", async () => {
    const search = vi.fn(async (_importerId: string) => []);
    const runAgent = createRunAgent({
      tools: {},
      generate: fakeGenerate(validOutput, validSteps),
      memory: fakeMemory({ search }),
    });

    await runAgent({ messages: "cotton t-shirt", tenant: TENANT });

    expect(search.mock.calls[0][0]).toBe(TENANT.importerId);
  });

  it("edge: a new importer with empty history classifies with no precedent block", async () => {
    const generate = fakeGenerate(validOutput, validSteps);
    const runAgent = createRunAgent({
      tools: {},
      generate,
      memory: fakeMemory({ search: async () => [] }),
    });

    const res = await runAgent({ messages: "cotton t-shirt", tenant: TENANT });

    expect(res.status).toBe(200);
    const args = (generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.system).not.toContain("Prior classifications");
  });

  it("persists the recommended decision-of-record after a successful classification", async () => {
    const insert = vi.fn(async (_record: unknown) => {});
    const runAgent = createRunAgent({
      tools: {},
      generate: fakeGenerate(validOutput, validSteps),
      memory: fakeMemory({ insert }),
    });

    await runAgent({ messages: "cotton t-shirt", tenant: TENANT });

    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0][0]).toMatchObject({
      importer_id: TENANT.importerId,
      user_id: TENANT.principal.userId,
      chosen_hts: validOutput.recommendation.hts_code,
      product_description: "cotton t-shirt",
    });
  });

  it("does NOT persist when the classification fails (nothing to record)", async () => {
    const insert = vi.fn(async () => {});
    const generate = vi.fn(async () => {
      throw new Error("gateway down");
    });
    const runAgent = createRunAgent({ tools: {}, generate, memory: fakeMemory({ insert }) });

    const res = await runAgent({ messages: "x", tenant: TENANT });

    expect(res.status).toBe(502);
    expect(insert).not.toHaveBeenCalled();
  });

  it("best-effort: a precedent-read outage still returns a 200 classification", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const search = vi.fn(async () => {
      throw new Error("memory backend down");
    });
    const runAgent = createRunAgent({
      tools: {},
      generate: fakeGenerate(validOutput, validSteps),
      memory: fakeMemory({ search }),
    });

    const res = await runAgent({ messages: "cotton t-shirt", tenant: TENANT });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ candidates: expect.any(Array) });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("best-effort: a persist failure does not deny the broker their answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const insert = vi.fn(async () => {
      throw new Error("insert rejected");
    });
    const runAgent = createRunAgent({
      tools: {},
      generate: fakeGenerate(validOutput, validSteps),
      memory: fakeMemory({ insert }),
    });

    const res = await runAgent({ messages: "cotton t-shirt", tenant: TENANT });

    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
