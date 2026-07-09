/**
 * U11 — the gated `/api/chat` Next route. The gate logic lives in
 * `lib/chat-gate.ts` (a Next route file may only export handlers + config); this
 * file is the thin server boundary. U6 wires the real agent loop behind the gate.
 */
import { handleChat } from "@/lib/chat-gate";

// Auth resolution + (eventually) the agent loop run server-side only (KTD11).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleChat(request);
}
