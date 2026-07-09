# ClearClass

Agentic RAG that classifies products into US HTS codes for customs brokers —
returning the top-3 candidate codes with GRI-based reasoning, citations, and a
recommendation you can defend. Submission for the AI Makerspace Certification
Challenge. See [`STRATEGY.md`](STRATEGY.md), the
[plan](docs/plans/2026-07-08-001-feat-clearclass-hts-classifier-plan.md), and
[`CHALLENGE.md`](CHALLENGE.md).

**Stack:** TypeScript · Next.js (App Router) · Vercel AI SDK · Insforge
(Postgres/pgvector, auth, model gateway, hosting) · Tavily · Cohere rerank.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in Insforge baseUrl/anonKey + gateway key
npm run dev                  # http://localhost:3000
```

The home page reports LLM-gateway health via `GET /api/health`.

### Corpus: schema + ingest + embed-load

The retrieval corpus is built in three scripted steps against the linked
Insforge project:

```bash
npm run migrate      # apply db schema via Insforge CLI (creates the `documents` table)
npm run ingest       # U2/U3 — fetch + chunk HTS/GRI/rulings into data/*.jsonl
npm run embed:load   # U4 — embed the chunks and load them into `documents` (truncates first)
```

> **Schema location:** the plan names `db/schema.sql`, but schema lives in
> `migrations/` and is applied with the Insforge CLI (`npm run migrate` →
> `db migrations up --all`), which tracks applied state remotely — the platform's
> supported path for DDL. This supersedes the plan's `db/schema.sql`.

## Deployment

**Live:** https://bp6d8gmu.insforge.site — health check at `/api/health`.

Deployed via Insforge Sites (`npm run deploy` → `npx @insforge/cli deployments
deploy .`), which runs a Vercel production build under the hood, satisfying the
"deployed to a public endpoint" requirement (R11).

Deployment env vars are stored in Insforge (not committed) and applied on every
build:

```bash
npx @insforge/cli deployments env list          # inspect
npx @insforge/cli deployments env set KEY VALUE  # add/update, then re-deploy
npm run deploy                                    # redeploy from source
```

To reconnect a fresh checkout: `npx @insforge/cli login` then
`npx @insforge/cli link --project-id <id>`, and `npx @insforge/cli ai setup` to
re-provision `OPENROUTER_API_KEY` into `.env.local`.

## Status

Unit U1 (scaffold + provisioning + deploy skeleton) — **complete and live**.
Corpus ingestion, retrieval, the agent loop, memory, chat UI, and the eval
harness land in U2–U11.
