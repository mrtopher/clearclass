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

## Provision + deploy (Insforge)

1. Create a project at [insforge.dev](https://insforge.dev) → copy the Project ID.
2. Link this repo: `npx @insforge/cli link --project-id <your-project-id>`
3. Set the deployment env vars (see `.env.example`) in the Insforge console.
4. Deploy: `npm run deploy` (`insforge deployments deploy .`).

Insforge Sites runs a Vercel production build under the hood, so the public URL
satisfies the "deployed to a public endpoint" requirement (R11).

## Status

Unit U1 (scaffold + provisioning + deploy skeleton) — walking skeleton only.
Corpus ingestion, retrieval, the agent loop, memory, chat UI, and the eval
harness land in U2–U11.
