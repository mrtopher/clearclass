import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embedMany, generateText } from "ai";

/**
 * Provider-agnostic LLM client (KTD9): all model calls (completions AND
 * embeddings) route through one OpenAI-compatible endpoint so the provider can
 * be swapped without touching call sites.
 *
 * Defaults to the OpenRouter gateway using the key `insforge ai setup`
 * provisions (`OPENROUTER_API_KEY`). To swap providers (e.g. Vercel AI
 * Gateway), set LLM_BASE_URL + LLM_API_KEY and they take precedence — R10
 * holds either way.
 *
 * All vars are SERVER-ONLY (no NEXT_PUBLIC_ prefix, KTD11). This module must
 * only be imported from API routes / server code, never a client bundle.
 */
const baseURL = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
const apiKey = process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY;

export const DEFAULT_MODEL = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";

/**
 * Embedding model for the corpus (U4) and query embedding (U5). Routed through
 * the same gateway as completions (KTD9). `text-embedding-3-small` emits 1536
 * dims — keep this in lockstep with the `vector(1536)` column in the documents
 * migration; changing the model to a different dimension requires re-embedding
 * into a new column (see the migration comment).
 */
export const DEFAULT_EMBEDDING_MODEL =
  process.env.LLM_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

function requireGatewayConfig(): { baseURL: string; apiKey: string } {
  if (!apiKey) {
    throw new Error(
      "LLM gateway not configured: run `npx @insforge/cli ai setup` to " +
        "provision OPENROUTER_API_KEY, or set LLM_API_KEY (server-only). " +
        "See .env.example.",
    );
  }
  return { baseURL, apiKey };
}

function gatewayProvider() {
  const config = requireGatewayConfig();
  return createOpenAICompatible({
    name: "insforge-gateway",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
}

export function chatModel(modelId: string = DEFAULT_MODEL) {
  return gatewayProvider().chatModel(modelId);
}

export function embeddingModel(modelId: string = DEFAULT_EMBEDDING_MODEL) {
  return gatewayProvider().textEmbeddingModel(modelId);
}

/**
 * Embed a batch of texts through the gateway, preserving input order (embeddings
 * line up positionally with `texts`). `embedMany` retries transient failures and
 * parallelizes internally; the caller (U4 load) still chunks the corpus so a
 * single request never carries the whole schedule. Asserts a 1:1 result so a
 * short provider response fails loudly instead of silently dropping vectors.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({
    model: embeddingModel(),
    values: texts,
  });
  if (embeddings.length !== texts.length) {
    throw new Error(
      `[llm] embedTexts expected ${texts.length} embeddings, got ${embeddings.length}`,
    );
  }
  return embeddings;
}

/**
 * U1 smoke test: proves a completion routes through the gateway (R10).
 * Consumed by GET /api/health and re-used by the deploy verification step.
 */
export async function gatewaySmoke(): Promise<{
  model: string;
  reply: string;
}> {
  const { text } = await generateText({
    model: chatModel(),
    prompt: "Reply with exactly: ClearClass gateway OK",
  });
  return { model: DEFAULT_MODEL, reply: text.trim() };
}
