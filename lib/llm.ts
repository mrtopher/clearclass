import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

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

export function chatModel(modelId: string = DEFAULT_MODEL) {
  const config = requireGatewayConfig();
  const provider = createOpenAICompatible({
    name: "insforge-gateway",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  return provider.chatModel(modelId);
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
