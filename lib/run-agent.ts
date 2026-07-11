/**
 * U6/U7 — the request-scoped `RunAgent` the U11 gate calls: it wraps the PURE
 * classification loop (`lib/agent.ts`) in the two things that make it a live
 * endpoint rather than an offline function — per-importer memory I/O and a
 * buffered `NextResponse`.
 *
 * ─ Why this is split out of `lib/agent.ts` ────────────────────────────────────
 * `lib/agent.ts` is the pure, offline-safe loop: it imports only the model SDK,
 * the gateway, the tools, and the schema. This module adds the two dependencies
 * that CANNOT load under a plain `tsx` offline script — `next/server`
 * (`NextResponse`) and `@/lib/memory` (which reaches `@insforge/sdk` via the
 * RLS-scoped auth client). Keeping them here lets the U10 eval harness import
 * `runClassification`/`defaultGenerate` from `lib/agent.ts` and drive the REAL
 * model loop offline, without dragging the SDK into a tsx process (where it
 * fails to resolve). The route (`app/api/chat`, via `lib/chat-gate`) imports
 * `createRunAgent` from here; nothing else does.
 */
import { NextResponse } from "next/server";
import type { ToolSet } from "ai";

import { createMemory, type MemoryDeps } from "@/lib/memory";
import { createRetrieveTool } from "@/lib/tools/retrieve";
import { createTavilyTool } from "@/lib/tools/tavily";
import type { RunAgent } from "@/lib/chat-gate";
import {
  BadInputError,
  defaultGenerate,
  latestUserText,
  MAX_STEPS,
  normalizeMessages,
  resolveReselect,
  RETRIEVE_TOOL,
  runClassification,
  WEB_SEARCH_TOOL,
  type ClassificationDeps,
  type GenerateFn,
} from "@/lib/agent";

export interface RunAgentOverrides {
  tools?: ToolSet;
  generate?: GenerateFn;
  maxSteps?: number;
  /** Inject fake memory I/O (embed / search / insert) in tests; defaults to the
   *  real gateway + the RLS-scoped authenticated client (`lib/memory.ts`). */
  memory?: Partial<MemoryDeps>;
  /** Force the Task-6.3 retrieval-support re-selection on/off (tests); defaults to
   *  the `AGENT_RESELECT` env arm via {@link resolveReselect}. */
  reselect?: boolean;
}

/**
 * Build the `RunAgent` the U11 gate calls once a request is authenticated and
 * tenant-scoped. Tools are constructed per call (cheap, lazy config); the model
 * call defaults to the real gateway but is overridable for tests. On a total
 * synthesis failure (the model itself, not a tool — tools self-degrade) it
 * returns a flagged 502 rather than leaking a stack, since the gate has already
 * ensured the caller is legitimate.
 *
 * U7 wraps the classification in per-importer memory: BEFORE synthesis it injects
 * this importer's similar prior decisions as precedent (AE3); AFTER a successful
 * synthesis it persists the recommended decision-of-record for future precedent.
 * Both are BEST-EFFORT and use the server-derived `tenant` (never client input):
 * a memory-read outage classifies without precedent, and a persist failure is
 * logged but never denies the broker their answer.
 */
export function createRunAgent(overrides: RunAgentOverrides = {}): RunAgent {
  return async ({ messages, tenant }) => {
    const tools: ToolSet = overrides.tools ?? {
      [RETRIEVE_TOOL]: createRetrieveTool(),
      [WEB_SEARCH_TOOL]: createTavilyTool(),
    };
    const deps: ClassificationDeps = {
      tools,
      generate: overrides.generate ?? defaultGenerate,
      maxSteps: overrides.maxSteps ?? MAX_STEPS,
      reselect: overrides.reselect ?? resolveReselect(),
    };
    // Per-request memory: created here so its query-embedding memoization (shared
    // between the precedent read and the persist) is scoped to this one request.
    const memory = createMemory(overrides.memory);
    try {
      // Normalize once here so a malformed request throws BadInputError → 400
      // BEFORE any memory I/O, and so precedent/persist see the same messages.
      const normalized = normalizeMessages(messages);
      const query = latestUserText(normalized);

      // Precedent is an enhancement, not a precondition — a memory-read failure
      // must not break the billable path, so it degrades to "no precedent".
      let precedent = "";
      try {
        precedent = await memory.fetchPrecedent(tenant.importerId, query);
      } catch (err) {
        console.warn("[agent] precedent lookup failed; classifying without it", err);
      }

      const result = await runClassification(
        { messages: normalized, precedent },
        deps,
      );

      // Persist the recommended decision-of-record (KTD7). Awaited so the insert
      // completes before the serverless function returns, but a failure is logged
      // and swallowed — the classification already succeeded and is returned.
      try {
        await memory.persistDecision(tenant, query, result);
      } catch (err) {
        console.warn("[agent] persisting classification memory failed", err);
      }

      return NextResponse.json(result);
    } catch (err) {
      // A malformed request is the caller's fault (400) — its own message is safe
      // to echo since it describes their input, not our internals.
      if (err instanceof BadInputError) {
        return NextResponse.json(
          { error: "invalid_request", detail: err.message },
          { status: 400 },
        );
      }
      // A model/tool/synthesis failure is a server degradation (502). Log the
      // detail server-side; do NOT leak the raw exception message to the client.
      console.error("[agent] classification failed", err);
      return NextResponse.json(
        { error: "classification_failed", degraded: true },
        { status: 502 },
      );
    }
  };
}
