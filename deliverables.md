# ClearClass — Deliverables Traceability

Maps every Certification Challenge deliverable **from the grading rubric** to (a) where it is
addressed in the write-up ([`SUBMISSION.md`](SUBMISSION.md)) and (b) its **exact code location**.
Point weights (100 total) are the rubric's.

- **Live app:** https://bp6d8gmu.insforge.site · health: `/api/health`
- **Demo login:** `broker@clearclass.demo` / `ClearClassDemo!2026`
- **Loom demo:** https://www.loom.com/share/65d82f3216894302aaaa87fd36baac73
- **Eval evidence:** [`eval/report.md`](eval/report.md) — reproducible with `npm run eval`

> Code locations are `path:line` anchors to symbols current as of this commit. Documents,
> diagrams, and prose deliverables point to the relevant [`SUBMISSION.md`](SUBMISSION.md) section.

---

## Task 1 — Defining your Problem, Audience, and Scope (9 pts)

| Deliverable | Pts | Write-up | Code / artifact |
|---|---|---|---|
| Succinct 1-sentence problem description | 1 | [SUBMISSION.md §"Problem"](SUBMISSION.md) | [`STRATEGY.md`](STRATEGY.md) "Target problem" |
| 1–2 paragraphs on why this is a problem for the user | 3 | [SUBMISSION.md §"Why this is a problem"](SUBMISSION.md) | — (prose) |
| Workflow diagram of how the user solves this today | 3 | [SUBMISSION.md §"Current-state workflow"](SUBMISSION.md) | Mermaid `flowchart TD` inline in SUBMISSION.md |
| List of questions / input-output pairs to evaluate the app | 2 | [SUBMISSION.md §"Evaluation input/output pairs"](SUBMISSION.md) | Ground truth: `data/eval-test-split.jsonl`; loader `eval/dataset.ts:100` (`loadTestRows`), normalizer `eval/dataset.ts:65` (`cleanQuery`) |

## Task 2 — Propose a Solution (15 pts)

| Deliverable | Pts | Write-up | Code / artifact |
|---|---|---|---|
| Describe your solution in one sentence | 1 | [SUBMISSION.md §"Solution"](SUBMISSION.md) | — (prose) |
| Infrastructure diagram of the stack + one sentence per tooling choice | 7 | [SUBMISSION.md §"Infrastructure diagram"](SUBMISSION.md) | component → code table below |
| Agent workflow diagram (end to end) + explanation | 7 | [SUBMISSION.md §"Agent workflow diagram"](SUBMISSION.md) | Loop `lib/agent.ts` · gate `lib/chat-gate.ts:47` · precedent `lib/memory.ts` |

**Infrastructure components → code:**

| Component | Choice | Code location |
|---|---|---|
| LLM | `gpt-4o-mini` | `lib/llm.ts:20` (`DEFAULT_MODEL`) |
| LLM gateway | Insforge → OpenRouter (OpenAI-compatible) | `lib/llm.ts:43` (`gatewayProvider`), `:52` (`chatModel`) |
| Agent orchestration | Vercel AI SDK (`ai` v5) | `lib/run-agent.ts:67` (`createRunAgent`), `lib/agent.ts` |
| Tool — retrieve (RAG) | corpus search | `lib/tools/retrieve.ts:85` (`createRetrieveTool`) |
| Tool — web search | Tavily | `lib/tools/tavily.ts:143` (`createTavilyTool`) |
| Embedding model | `text-embedding-3-small` (1536-d) | `lib/llm.ts:29` (`DEFAULT_EMBEDDING_MODEL`), `:56` (`embeddingModel`) |
| Vector database | Postgres + pgvector | `migrations/20260709175741_create-documents.sql`, `migrations/20260709180500_create-match-documents-rpc.sql`; reader `lib/retrieval/dense.ts` |
| Monitoring | Langfuse (OpenTelemetry) | `instrumentation.ts:47` (`LangfuseSpanProcessor`), `lib/observability.ts` |
| Evaluation framework | custom harness | `eval/run.ts`, `eval/scorers.ts`, `eval/retrieval-recall.ts` |
| Memory | per-importer precedent | `lib/memory.ts:172` (`formatPrecedent`), `migrations/20260709200000_u7-classifications-memory.sql` |
| User interface | Next.js App Router (responsive) | `app/page.tsx`, `app/layout.tsx`, `components/ClassifierChat.tsx` |
| Deployment | Insforge Sites (Vercel-backed) | `npm run deploy`; live at https://bp6d8gmu.insforge.site |

## Task 3 — Dealing with the Data (10 pts)

| Deliverable | Pts | Write-up | Code / artifact |
|---|---|---|---|
| Describe all data sources and external APIs + their use | 5 | [SUBMISSION.md §"Data source and external API"](SUBMISSION.md) | Own data (RAG): HTS `scripts/ingest-hts.ts`, GRI `scripts/ingest-gri.ts`, CBP CROSS rulings `scripts/ingest-rulings.ts:51`; external API (Agent): Tavily `lib/tools/tavily.ts` |
| Default chunking strategy + why | 5 | [SUBMISSION.md §"Chunking strategy, and why"](SUBMISSION.md) | HTS (one chunk/tariff line, hierarchy-preserving) `lib/chunking.ts:140` (`chunkHtsRows`); GRI `lib/gri.ts:134` (`buildGriChunks`); rulings `lib/rulings.ts` |

## Task 4 — Build End-to-End Prototype (15 pts)

| Deliverable | Pts | Write-up | Code / artifact |
|---|---|---|---|
| Build an end-to-end prototype and deploy with a front end | 15 | [SUBMISSION.md §"Task 4"](SUBMISSION.md) | Backend entry `app/api/chat/route.ts:12` (`POST`) → `lib/run-agent.ts:67` → `lib/agent.ts`; frontend `components/ClassifierChat.tsx`, `app/page.tsx`; deployed via `npm run deploy` to https://bp6d8gmu.insforge.site; health `app/api/health/route.ts:13` |

## Task 5 — Evals (15 pts)

| Deliverable | Pts | Write-up | Code / artifact |
|---|---|---|---|
| Prepare a test dataset | 2 | [SUBMISSION.md §"Test dataset"](SUBMISSION.md) | `data/eval-test-split.jsonl` (flexifyai CROSS-derived, 200-row held-out); loader `eval/dataset.ts:100`; leakage guard `eval/dataset.ts:255` (`assertNoLeakage`) |
| Create an evaluation harness relevant to the problem | 10 | [SUBMISSION.md §"Evaluation harness"](SUBMISSION.md) | `eval/run.ts`; scorers `eval/scorers.ts:81` (`summarizeAccuracy`), `:357` (`renderReport`); recall `eval/retrieval-recall.ts` |
| Conclusions about pipeline performance | 3 | [SUBMISSION.md §"Conclusions"](SUBMISSION.md) + §6.2 | [`eval/report.md`](eval/report.md) |

## Task 6 — Improving Your Prototype (14 pts)

| Deliverable | Pts | Write-up | Code / artifact |
|---|---|---|---|
| Advanced retrieval technique + why | 6 | [SUBMISSION.md §6.1](SUBMISSION.md) | Hybrid + RRF `lib/retrieval/hybrid.ts`; Cohere rerank `lib/retrieval/rerank.ts:92` (`createCohereRerank`), `:132` (`rerankChunks`); lexical arm `migrations/20260709210000_u9-lexical-search-rpc.sql` |
| Performance comparison vs. original (table) | 2 | [SUBMISSION.md §6.2](SUBMISSION.md) | [`eval/report.md`](eval/report.md); renderer `eval/scorers.ts:357` |
| ≥1 additional improvement, eval-backed | 6 | [SUBMISSION.md §6.3](SUBMISSION.md) (agent re-selection), [§6.4](SUBMISSION.md) (query rewrite) | Re-selection `lib/agent.ts:426` (`reselectByRetrievalSupport`), `:357` (`resolveReselect`); HyDE rewrite `lib/retrieval/rewrite.ts:59` (`resolveQueryRewrite`), `:115` (`buildRewritePrompt`) |

## Task 7 — Next Steps (2 pts)

| Deliverable | Pts | Write-up | Code / artifact |
|---|---|---|---|
| Keep / change reflection for Demo Day | 2 | [SUBMISSION.md §"Task 7"](SUBMISSION.md) | Shipped since plan: Langfuse `instrumentation.ts:33` (`register`); A/B seams `lib/agent.ts:357` (`AGENT_RESELECT`), `lib/retrieval/rewrite.ts:44` |

## Final Submission (20 pts)

| Deliverable | Pts | Location |
|---|---|---|
| 10-minute (or less) Loom video: live demo + use case | 10 | https://www.loom.com/share/65d82f3216894302aaaa87fd36baac73 |
| Written document addressing each deliverable | 10 | [`SUBMISSION.md`](SUBMISSION.md) (per-task write-up) + this [`deliverables.md`](deliverables.md) (traceability) |
| All relevant code | 0 | This repository — https://github.com/mrtopher/clearclass |

**Total: 100 pts.**

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
