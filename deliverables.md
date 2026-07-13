# ClearClass — Deliverables Traceability

Maps every Certification Challenge task deliverable to (a) where it is addressed in the
write-up ([`SUBMISSION.md`](SUBMISSION.md)) and (b) its **exact code location**.
Deliverables are taken from [`CHALLENGE.md`](CHALLENGE.md) (Tasks 1–7).

- **Live app:** https://bp6d8gmu.insforge.site · health: `/api/health`
- **Demo login:** `broker@clearclass.demo` / `ClearClassDemo!2026`
- **Loom demo:** https://www.loom.com/share/65d82f3216894302aaaa87fd36baac73
- **Eval evidence:** [`eval/report.md`](eval/report.md) — reproducible with `npm run eval`

> Code locations are `path:line` anchors to symbols current as of this commit. Documents,
> diagrams, and prose deliverables point to the relevant [`SUBMISSION.md`](SUBMISSION.md) section.

---

## Task 1 — Problem, Audience, and Scope

| # | Deliverable | Write-up | Code / artifact |
|---|---|---|---|
| 1 | One-sentence problem (no solution) | [SUBMISSION.md §"Problem"](SUBMISSION.md) | [`STRATEGY.md`](STRATEGY.md) "Target problem" |
| 2 | 1–2 paragraphs: who has it, what they're doing, how they handle it today, why that's not enough | [SUBMISSION.md §"Why this is a problem"](SUBMISSION.md) | — (prose) |
| 3 | Current-state workflow diagram (steps, tools/systems, slow/error-prone points) | [SUBMISSION.md §"Current-state workflow"](SUBMISSION.md) | Mermaid `flowchart TD` inline in SUBMISSION.md |
| 4 | List of questions / input-output pairs to evaluate the app | [SUBMISSION.md §"Evaluation input/output pairs"](SUBMISSION.md) | Ground-truth set: `data/eval-test-split.jsonl` (regenerable); loader + question-framing normalizer: `eval/dataset.ts:65` (`cleanQuery`), `eval/dataset.ts:100` (`loadTestRows`) |

## Task 2 — Proposed Solution

| # | Deliverable | Write-up | Code / artifact |
|---|---|---|---|
| 1 | One-sentence solution | [SUBMISSION.md §"Solution"](SUBMISSION.md) | — (prose) |
| 2 | Infrastructure diagram + one sentence per component | [SUBMISSION.md §"Infrastructure diagram"](SUBMISSION.md) | see component table below |
| 3 | Agent workflow diagram + 1–2 paragraph explanation | [SUBMISSION.md §"Agent workflow diagram"](SUBMISSION.md) | Loop: `lib/agent.ts` · gate: `lib/chat-gate.ts:47` · precedent: `lib/memory.ts` |

**Task 2 required components → code:**

| Component | Choice | Code location |
|---|---|---|
| LLM | `gpt-4o-mini` | `lib/llm.ts:20` (`DEFAULT_MODEL`) |
| LLM gateway | Insforge → OpenRouter (OpenAI-compatible) | `lib/llm.ts:43` (`gatewayProvider`), `lib/llm.ts:52` (`chatModel`) |
| Agent orchestration | Vercel AI SDK (`ai` v5) | `lib/run-agent.ts:67` (`createRunAgent`), `lib/agent.ts` |
| Tool — retrieve (RAG) | corpus search | `lib/tools/retrieve.ts:85` (`createRetrieveTool`) |
| Tool — web search | Tavily | `lib/tools/tavily.ts:143` (`createTavilyTool`), `:107` (`createTavilySearch`) |
| Embedding model | `text-embedding-3-small` (1536-d) | `lib/llm.ts:29` (`DEFAULT_EMBEDDING_MODEL`), `:56` (`embeddingModel`) |
| Vector database | Postgres + pgvector | `migrations/20260709175741_create-documents.sql`, `migrations/20260709180500_create-match-documents-rpc.sql`; reader `lib/retrieval/dense.ts` |
| Monitoring | Langfuse (OpenTelemetry) | `instrumentation.ts:47` (`LangfuseSpanProcessor`), `lib/observability.ts` |
| Evaluation framework | custom harness (recall@k, exact-match, RAGAS-port) | `eval/run.ts`, `eval/scorers.ts`, `eval/retrieval-recall.ts` |
| Memory | per-importer precedent | `lib/memory.ts:172` (`formatPrecedent`), `migrations/20260709200000_u7-classifications-memory.sql` |
| User interface | Next.js App Router (responsive, phone + laptop) | `app/page.tsx`, `app/layout.tsx`, `components/ClassifierChat.tsx` |
| Deployment | Insforge Sites (Vercel-backed) | `npm run deploy` (`package.json`), live at https://bp6d8gmu.insforge.site |

## Task 3 — Dealing with the Data

| # | Deliverable | Write-up | Code / artifact |
|---|---|---|---|
| 1 | Default chunking strategy + why | [SUBMISSION.md §"Chunking strategy, and why"](SUBMISSION.md) | HTS (hierarchy-preserving, one chunk/tariff line): `lib/chunking.ts:140` (`chunkHtsRows`); GRI: `lib/gri.ts:134` (`buildGriChunks`); rulings: `lib/rulings.ts` |
| 2 | Data source + external API, roles, and how they interact | [SUBMISSION.md §"Data source and external API"](SUBMISSION.md) | Own data (RAG): USITC HTS `scripts/ingest-hts.ts`, GRI `scripts/ingest-gri.ts`, CBP CROSS rulings `scripts/ingest-rulings.ts:51`; external API (Agent): Tavily `lib/tools/tavily.ts` |

## Task 4 — End-to-End Agentic RAG Prototype

| # | Deliverable | Write-up | Code / artifact |
|---|---|---|---|
| 1 | Build an end-to-end prototype | [SUBMISSION.md §"Task 4"](SUBMISSION.md) | Entry: `app/api/chat/route.ts:12` (`POST`) → `lib/run-agent.ts:67` → `lib/agent.ts`; UI `components/ClassifierChat.tsx` |
| 2 | Deploy to a public endpoint | [SUBMISSION.md §"Task 4"](SUBMISSION.md) | https://bp6d8gmu.insforge.site; deploy `npm run deploy`; health check `app/api/health/route.ts:13` (`GET`) |

## Task 5 — Evals

| # | Deliverable | Write-up | Code / artifact |
|---|---|---|---|
| 1 | Prepare a test dataset | [SUBMISSION.md §"Test dataset"](SUBMISSION.md) | `data/eval-test-split.jsonl` (flexifyai CROSS-derived, 200-row held-out); loader `eval/dataset.ts:100`; leakage guard `eval/dataset.ts:255` (`assertNoLeakage`) |
| 2 | Create an evaluation harness | [SUBMISSION.md §"Evaluation harness"](SUBMISSION.md) | `eval/run.ts`; scorers `eval/scorers.ts:81` (`summarizeAccuracy`), `:357` (`renderReport`); recall `eval/retrieval-recall.ts` |
| 3 | Conclusions about pipeline performance | [SUBMISSION.md §"Conclusions"](SUBMISSION.md) + §6.2 | [`eval/report.md`](eval/report.md) |

## Task 6 — Improving the Prototype

| # | Deliverable | Write-up | Code / artifact |
|---|---|---|---|
| 1 | Advanced retrieval technique + why | [SUBMISSION.md §6.1](SUBMISSION.md) | Hybrid + RRF: `lib/retrieval/hybrid.ts`; Cohere rerank: `lib/retrieval/rerank.ts:92` (`createCohereRerank`), `:132` (`rerankChunks`); lexical arm `migrations/20260709210000_u9-lexical-search-rpc.sql` |
| 2 | Performance comparison vs. original (table) | [SUBMISSION.md §6.2](SUBMISSION.md) | [`eval/report.md`](eval/report.md); table renderer `eval/scorers.ts:357` |
| 3 | ≥1 additional improvement + eval-backed evidence | [SUBMISSION.md §6.3](SUBMISSION.md) (agent-side re-selection), [§6.4](SUBMISSION.md) (query rewrite) | Re-selection: `lib/agent.ts:426` (`reselectByRetrievalSupport`), `:357` (`resolveReselect`); HyDE rewrite: `lib/retrieval/rewrite.ts:59` (`resolveQueryRewrite`), `:115` (`buildRewritePrompt`) |

## Task 7 — Next Steps

| # | Deliverable | Write-up | Code / artifact |
|---|---|---|---|
| 1 | Keep / change reflection for Demo Day | [SUBMISSION.md §"Task 7"](SUBMISSION.md) | Shipped since plan: Langfuse tracing `instrumentation.ts:33` (`register`); A/B seams `lib/agent.ts:357` (`AGENT_RESELECT`), `lib/retrieval/rewrite.ts:44` (rewrite strategy) |

---

## Cross-cutting (supports multiple deliverables)

| Concern | Code location |
|---|---|
| Defensibility contract — server-side citation validation | `lib/agent.ts:257` (`validateCandidateCitations`), `:191` (`deriveSourcesUsed`) |
| System prompt — broker persona, GRI policy, tool-use rules | `lib/agent.ts:285` (`buildSystemPrompt`) |
| Auth + tenant isolation (JWT-derived importer, RLS) | `lib/auth.ts:25` (`Principal`), `:32` (`TenantContext`); `migrations/20260709190000_create-auth-tenant-tables.sql`; verify `scripts/verify-rls.ts` |
| Request gate (401 unauthenticated / 403 wrong importer) | `lib/chat-gate.ts:47` (`handleChat`) |
| Result rendering (candidates, citations, sources marker) | `components/CandidateCard.tsx`, `components/Citation.tsx`, `lib/classification-view.ts` |

## Reproduce

```bash
npm run eval                                   # sampled sanity pass (both retrieval modes)
npm run eval -- --recall-only                  # primary Task-6 recall@k signal
npm run eval -- --e2e-limit=200 --rag-limit=40 # full run behind the §6.2 tables
```
