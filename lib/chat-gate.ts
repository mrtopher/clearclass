/**
 * U11 — the `/api/chat` auth gate, kept OUT of the Next route file so it can be
 * unit-tested and dependency-injected. (`app/api/chat/route.ts` may only export
 * Next's route handlers + config, not arbitrary helpers.)
 *
 * U11 ships the GATE; U6 fills the body. The ordering is the whole point: the
 * principal + server-derived tenant are resolved BEFORE `runAgent`, so no
 * billable model/search/rerank call can fire for an unauthenticated request or
 * for an importer the broker is not a member of (the U11 verification contract).
 * The billable loop is an injectable seam (`ChatDeps.runAgent`) precisely so the
 * gate is provable without any model call — tests inject a spy and assert it is
 * never reached on the rejected paths. The whole loop runs server-side only
 * (KTD11); U6 wired the real agent as `defaultDeps.runAgent`.
 */
import { NextResponse } from "next/server";

import {
  resolveTenant,
  type ResolveTenantResult,
  type TenantContext,
} from "@/lib/auth";
import { createRunAgent } from "@/lib/run-agent";

/** The billable agent loop U6 will implement, behind the gate this unit establishes. */
export type RunAgent = (input: {
  messages: unknown;
  tenant: TenantContext;
}) => Promise<Response>;

export interface ChatDeps {
  resolveTenant: (requested?: string | null) => Promise<ResolveTenantResult>;
  runAgent: RunAgent;
}

const defaultDeps: ChatDeps = {
  resolveTenant,
  // U6: the real agentic classification loop, run only after the gate resolves a
  // verified principal + server-derived importer. Built once here (lazy config —
  // constructing it needs no credentials); the model call fires only per request.
  runAgent: createRunAgent(),
};

/**
 * Core handler, dependency-injected so the gate is unit-testable without a
 * backend or a model. The route's `POST` binds the real dependencies.
 */
export async function handleChat(
  request: Request,
  deps: ChatDeps = defaultDeps,
): Promise<Response> {
  // Read the client's REQUESTED importer, if any. It is never the tenant key —
  // only a request to be validated against membership server-side (KTD10).
  let requestedImporterId: string | null = null;
  let messages: unknown;
  try {
    const body = await request.json();
    requestedImporterId =
      typeof body?.importerId === "string" ? body.importerId : null;
    messages = body?.messages;
  } catch {
    // Missing/invalid JSON body: fine — the gate below still runs and rejects an
    // unauthenticated caller before anything billable.
  }

  // THE GATE. Resolve the verified principal + server-derived importer. Any
  // failure short-circuits here, before `runAgent` — no billable call without a
  // session (401) or without a legitimate importer (403).
  const resolution = await deps.resolveTenant(requestedImporterId);
  if (!resolution.ok) {
    return NextResponse.json(
      { error: resolution.reason },
      { status: resolution.status },
    );
  }

  return deps.runAgent({ messages, tenant: resolution.context });
}
