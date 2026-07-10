/**
 * U8 — the classifier interaction (R4, R5, R9). A broker pastes a product
 * description; we POST it to the gated `/api/chat` and render the buffered,
 * server-verified `ClassificationResult` as three ranked candidate cards, a
 * recommendation summary, and the sources-used marker (AE1/AE2).
 *
 * ─ Why plain fetch, not `useChat` ─────────────────────────────────────────────
 * The plan sketched `useChat` streaming, but U6 deliberately returns a BUFFERED
 * JSON response so the server can verify citations before replying (you can't
 * un-stream bytes — see `lib/agent.ts`). So this is a single request/response,
 * not a token stream: submit → loading → rendered result (or a mapped error).
 *
 * The importer selector is a convenience only; the effective tenant is always
 * re-derived server-side from the JWT (KTD10). We send `importerId` as a hint the
 * server validates, never as the authority.
 */
"use client";

import { useState } from "react";

import { CandidateCard } from "@/components/CandidateCard";
import { ImporterSelector } from "@/components/ImporterSelector";
import {
  chatErrorMessage,
  describeSources,
  toCandidateViews,
  type ChatErrorBody,
} from "@/lib/classification-view";
import type { ClassificationResult } from "@/lib/schema";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; result: ClassificationResult };

function looksLikeResult(data: unknown): data is ClassificationResult {
  return (
    typeof data === "object" &&
    data !== null &&
    Array.isArray((data as ClassificationResult).candidates) &&
    (data as ClassificationResult).candidates.length === 3
  );
}

export function ClassifierChat({
  memberships,
  defaultImporterId,
}: {
  memberships: string[];
  defaultImporterId: string;
}) {
  const [description, setDescription] = useState("");
  const [importerId, setImporterId] = useState(defaultImporterId);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const busy = status.kind === "loading";

  async function classify(e: React.FormEvent) {
    e.preventDefault();
    const text = description.trim();
    if (!text || busy) return;

    setStatus({ kind: "loading" });
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: text, importerId }),
      });

      if (!res.ok) {
        let body: ChatErrorBody | undefined;
        try {
          body = (await res.json()) as ChatErrorBody;
        } catch {
          // Non-JSON error body (e.g. a platform 5xx) — fall back to status-only.
        }
        setStatus({ kind: "error", message: chatErrorMessage(res.status, body) });
        return;
      }

      const data: unknown = await res.json();
      if (!looksLikeResult(data)) {
        setStatus({ kind: "error", message: chatErrorMessage(502) });
        return;
      }
      setStatus({ kind: "done", result: data });
    } catch {
      // Network failure / offline — the request never reached the server.
      setStatus({
        kind: "error",
        message: "Couldn't reach the classifier. Check your connection and try again.",
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={classify} className="flex flex-col gap-3">
        {memberships.length > 1 ? (
          <ImporterSelector
            memberships={memberships}
            value={importerId}
            onChange={setImporterId}
            disabled={busy}
          />
        ) : null}

        <label htmlFor="product-description" className="sr-only">
          Product description
        </label>
        <textarea
          id="product-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
          rows={4}
          placeholder="Describe the product to classify — material, use, form, and any distinguishing attributes."
          className="w-full resize-y rounded-xl border border-neutral-300 bg-white p-3 text-sm outline-none focus:border-neutral-400 focus:ring-2 focus:ring-neutral-200 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:ring-neutral-800"
        />

        <button
          type="submit"
          disabled={busy || description.trim().length === 0}
          className="self-start rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {busy ? "Classifying…" : "Classify"}
        </button>
      </form>

      <div aria-live="polite" className="flex flex-col gap-3">
        {status.kind === "loading" ? (
          <p className="text-sm text-neutral-500">
            Retrieving authority and reasoning through the General Rules of
            Interpretation…
          </p>
        ) : null}

        {status.kind === "error" ? (
          <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {status.message}
          </p>
        ) : null}

        {status.kind === "done" ? (
          <ClassificationView result={status.result} />
        ) : null}
      </div>
    </div>
  );
}

function ClassificationView({ result }: { result: ClassificationResult }) {
  const candidates = toCandidateViews(result);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-500">
          Top 3 candidates
        </h2>
        <span className="text-xs text-neutral-400">
          {describeSources(result.sources_used)}
        </span>
      </div>
      {candidates.map((candidate) => (
        <CandidateCard key={candidate.hts_code} candidate={candidate} />
      ))}
    </section>
  );
}
