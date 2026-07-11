/**
 * Task 7 #3 — Langfuse tracing, the SERVER-RUNTIME half.
 *
 * Next.js calls `register()` once at server startup (the built-in instrumentation
 * hook — no config flag needed in Next 15). Here we stand up an OpenTelemetry
 * tracer provider whose only span processor is Langfuse's: the AI SDK's
 * `experimental_telemetry` spans (model steps, `retrieve`/`web_search` tool calls
 * with their retrieved chunks, token usage) flow through the global tracer this
 * registers and out to Langfuse.
 *
 * ─ Why the OTel/Langfuse imports live HERE and nowhere else ───────────────────
 * This is the one module Next loads only in the server runtime, so it is the
 * right (and only) place to pull in `@langfuse/otel` + the OTel Node SDK. Keeping
 * them out of `lib/agent.ts` preserves that module's tsx-offline importability
 * (the eval harness). The heavy imports are additionally `await import()`-ed
 * lazily *inside* `register()` so they load only when tracing is actually
 * configured — an unconfigured deploy pays nothing.
 *
 * ─ Fail-safe OFF ──────────────────────────────────────────────────────────────
 * No Langfuse keys → no provider, and {@link flushTraces} stays a no-op. Tracing
 * is a pure add-on; it can never break the billable `/api/chat` path.
 */
import { langfuseConfig } from "@/lib/observability";

/**
 * Drains buffered spans to Langfuse. Rebound to the real processor's `forceFlush`
 * once {@link register} wires tracing up; a no-op until then (and forever, if
 * tracing is unconfigured). The request path calls this via `after()` so a
 * short-lived server instance exports its spans before the process can be frozen.
 */
let flush: () => Promise<void> = async () => {};

export async function register(): Promise<void> {
  // Only the Node.js server runtime runs the agent loop and the OTel Node SDK;
  // the Edge runtime (middleware) must not load these packages.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const config = langfuseConfig();
  if (!config) {
    console.info(
      "[observability] Langfuse keys not set; agent tracing disabled (set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY to enable)",
    );
    return;
  }

  // Lazy so an unconfigured deploy never loads the OTel graph at all.
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");
  const { NodeTracerProvider } = await import("@opentelemetry/sdk-trace-node");

  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    baseUrl: config.baseUrl,
  });

  // Registering the provider globally is what makes the AI SDK's
  // `experimental_telemetry` spans land on this processor — no per-call wiring.
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  flush = () => processor.forceFlush();

  console.info("[observability] Langfuse agent tracing enabled");
}

/**
 * Flush buffered traces, swallowing any exporter error. Called from the request
 * path via `after()` (post-response, so it adds no latency to the broker's
 * answer). Never throws — a telemetry-transport failure must not surface on the
 * billable path.
 */
export async function flushTraces(): Promise<void> {
  try {
    await flush();
  } catch (err) {
    console.warn("[observability] Langfuse trace flush failed", err);
  }
}
