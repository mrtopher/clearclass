/**
 * Task 7 #3 — Langfuse tracing, the OFFLINE-SAFE half.
 *
 * The AI SDK and Langfuse both speak OpenTelemetry, so per-request agent traces
 * (each model step, every `retrieve`/`web_search` tool call with its retrieved
 * chunks, and token spend) come almost for free: flip `experimental_telemetry`
 * on the `generateText` call (`lib/agent.ts#defaultGenerate`) and a
 * `LangfuseSpanProcessor` registered in `instrumentation.ts` ships the spans.
 *
 * ─ Why this module holds ZERO OpenTelemetry / Langfuse imports ────────────────
 * `lib/agent.ts` must stay importable by the `tsx` eval harness (KTD offline
 * loop — same reason `lib/run-agent.ts` is split out). The OTel provider and the
 * `@langfuse/otel` package live ONLY in the root `instrumentation.ts`, which Next
 * loads in the server runtime. This module hands `lib/agent.ts` nothing but a
 * plain config object — the AI SDK's `experimental_telemetry` settings — so the
 * pure loop gains tracing without dragging a runtime dependency into tsx.
 *
 * ─ Fail-safe OFF, like every other enhancement here ───────────────────────────
 * No Langfuse keys → {@link langfuseConfig} returns null → {@link telemetrySettings}
 * returns `undefined` (the AI SDK then emits nothing) AND `instrumentation.ts`
 * never registers a provider. Tracing can never break the billable path: it is a
 * pure add-on gated entirely on the presence of operator-supplied credentials.
 */
import type { TelemetrySettings } from "ai";

/** Resolved Langfuse credentials — all three are needed to export. */
export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  /** Data-region host. Defaults to Langfuse Cloud EU when unset. */
  baseUrl: string;
}

/**
 * The Langfuse config from the environment, or `null` when tracing is off.
 * Both keys are required (a public key alone can't authenticate an export), so a
 * half-configured environment resolves to OFF rather than throwing on export.
 * `baseUrl` accepts the historical `LANGFUSE_BASEURL` spelling (already reserved
 * in `.env.example`) and the SDK's current `LANGFUSE_BASE_URL`, defaulting to the
 * EU cloud host. Read fresh each call — cheap, and keeps tests hermetic (they can
 * set/unset env per case without a cached singleton fighting them).
 */
export function langfuseConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return null;
  const baseUrl =
    process.env.LANGFUSE_BASEURL?.trim() ||
    process.env.LANGFUSE_BASE_URL?.trim() ||
    "https://cloud.langfuse.com";
  return { publicKey, secretKey, baseUrl };
}

/** Whether Langfuse tracing is configured (both keys present). */
export function langfuseEnabled(): boolean {
  return langfuseConfig() !== null;
}

/**
 * Per-request trace attributes derived from the SERVER-resolved tenant (never
 * client input, matching KTD10). Only opaque identifiers — never the broker's
 * email or other PII — reach the observability backend.
 */
export interface TelemetryMetadata {
  /** The verified broker principal (`auth.users.id`) → Langfuse trace `userId`. */
  userId?: string;
  /** The effective importer scope → a searchable trace attribute. */
  importerId?: string;
}

/**
 * The AI SDK `experimental_telemetry` settings for a classification run, or
 * `undefined` when Langfuse is not configured (the SDK then records nothing).
 *
 * Langfuse's span processor lifts a few well-known metadata keys to trace-level
 * fields: `userId` becomes the trace user and `tags` become trace tags, so a
 * regression or a costly run is filterable by broker in the dashboard. Inputs and
 * outputs (the product description and the ranked candidates, including the
 * retrieved chunk ids the citations reference) are recorded by the SDK default —
 * that visibility is the point of the trace, and it stays behind operator-held
 * keys on the server-only path.
 */
export function telemetrySettings(
  opts: { functionId?: string; metadata?: TelemetryMetadata } = {},
): TelemetrySettings | undefined {
  if (!langfuseEnabled()) return undefined;

  const metadata: Record<string, string | string[]> = {
    tags: ["clearclass", "classify"],
  };
  if (opts.metadata?.userId) metadata.userId = opts.metadata.userId;
  if (opts.metadata?.importerId) metadata.importerId = opts.metadata.importerId;

  return {
    isEnabled: true,
    functionId: opts.functionId,
    metadata,
  };
}
