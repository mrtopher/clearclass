"use client";

import { useEffect, useState } from "react";

type Health =
  | { status: "loading" }
  | { status: "ok"; gateway: { model: string; reply: string } }
  | { status: "error"; message: string };

export default function Home() {
  const [health, setHealth] = useState<Health>({ status: "loading" });

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data: Health) => setHealth(data))
      .catch((e: unknown) =>
        setHealth({ status: "error", message: String(e) }),
      );
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-6 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">ClearClass</h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Defensible HTS classification for customs brokers — top-3 candidates
          with GRI reasoning, citations, and confidence.
        </p>
      </header>

      <section
        aria-live="polite"
        className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-neutral-500">
          Deployment health
        </h2>
        <GatewayStatus health={health} />
      </section>

      <p className="text-xs text-neutral-400">
        U1 skeleton — the classifier chat lands in U8.
      </p>
    </main>
  );
}

function GatewayStatus({ health }: { health: Health }) {
  if (health.status === "loading") {
    return <p className="text-neutral-500">Checking LLM gateway…</p>;
  }
  if (health.status === "error") {
    return (
      <div className="space-y-1">
        <p className="font-medium text-red-600 dark:text-red-400">
          ● Gateway unreachable
        </p>
        <p className="break-words text-sm text-neutral-500">{health.message}</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="font-medium text-green-600 dark:text-green-400">
        ● Gateway OK
      </p>
      <p className="text-sm text-neutral-500">
        <span className="font-mono">{health.gateway.model}</span> —{" "}
        {health.gateway.reply}
      </p>
    </div>
  );
}
