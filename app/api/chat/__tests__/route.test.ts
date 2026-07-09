import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { handleChat, type ChatDeps } from "@/app/api/chat/route";
import {
  resolveEffectiveImporter,
  type ResolveTenantResult,
  type TenantContext,
} from "@/lib/auth";

/**
 * The U11 gate contract: no billable path runs without a verified session and a
 * legitimate importer. The billable loop is injected as a spy (`runAgent`), so
 * "no model call fires" is asserted directly — the spy must never be called on a
 * rejected request. The authenticated fakes run the REAL `resolveEffectiveImporter`
 * so the route and the KTD10 decision are exercised together.
 */

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const PRINCIPAL = { userId: "broker-1", email: "broker@example.com" };

/** An unauthenticated session: the gate rejects before anything billable. */
const unauthenticated = async (): Promise<ResolveTenantResult> => ({
  ok: false,
  status: 401,
  reason: "unauthenticated",
});

/** An authenticated broker whose verified memberships are exactly `memberships`. */
function authenticatedWith(memberships: string[]) {
  return async (requested?: string | null): Promise<ResolveTenantResult> => {
    const decision = resolveEffectiveImporter(memberships, requested);
    if (!decision.ok) return { ok: false, status: 403, reason: decision.reason };
    const context: TenantContext = {
      principal: PRINCIPAL,
      importerId: decision.importerId,
      memberships,
    };
    return { ok: true, context };
  };
}

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function spyDeps(
  resolveTenant: ChatDeps["resolveTenant"],
): { deps: ChatDeps; runAgent: ReturnType<typeof vi.fn> } {
  const runAgent = vi.fn(async ({ tenant }: { tenant: TenantContext }) =>
    NextResponse.json({ ran: true, importerId: tenant.importerId }),
  );
  return { deps: { resolveTenant, runAgent }, runAgent };
}

describe("handleChat gate", () => {
  it("rejects an unauthenticated request with 401 and never touches the billable path", async () => {
    const { deps, runAgent } = spyDeps(unauthenticated);

    const res = await handleChat(chatRequest({ messages: [] }), deps);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthenticated" });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("classifies for an authenticated broker under their server-derived importer", async () => {
    const { deps, runAgent } = spyDeps(authenticatedWith([A]));

    const res = await handleChat(
      chatRequest({ importerId: A, messages: ["cotton t-shirt"] }),
      deps,
    );

    expect(res.status).toBe(200);
    expect(runAgent).toHaveBeenCalledOnce();
    // The tenant handed to the billable loop is the server-derived one.
    expect(runAgent.mock.calls[0][0].tenant.importerId).toBe(A);
  });

  it("blocks cross-importer access (requested importer the broker is not a member of)", async () => {
    // Broker is a member of A only; the client request asks for B.
    const { deps, runAgent } = spyDeps(authenticatedWith([A]));

    const res = await handleChat(chatRequest({ importerId: B }), deps);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden-importer" });
    // The manipulated importer never reaches a billable call.
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("passes the client's requested importer to resolution only as an untrusted hint", async () => {
    const resolveTenant = vi.fn(authenticatedWith([A, B]));
    const { deps } = spyDeps(resolveTenant);

    await handleChat(chatRequest({ importerId: B, messages: [] }), deps);

    // The route forwards the body's importerId to be VALIDATED — it is never used
    // as the tenant key directly.
    expect(resolveTenant).toHaveBeenCalledWith(B);
  });

  it("still gates when the body is missing or invalid JSON", async () => {
    const { deps, runAgent } = spyDeps(unauthenticated);

    const res = await handleChat(
      new Request("http://localhost/api/chat", { method: "POST" }),
      deps,
    );

    expect(res.status).toBe(401);
    expect(runAgent).not.toHaveBeenCalled();
  });
});
