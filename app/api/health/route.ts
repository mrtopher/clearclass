import { NextResponse } from "next/server";
import { gatewaySmoke } from "@/lib/llm";

// The agent loop and gateway calls run server-side only (KTD11).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * U1 verification endpoint (R10, R11): proves the deployed app can reach the
 * LLM gateway. Returns 200 with the model's reply on success, 503 with the
 * reason on failure — so the deploy smoke test is a single URL check.
 */
export async function GET() {
  try {
    const gateway = await gatewaySmoke();
    return NextResponse.json({ status: "ok", gateway });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }
}
