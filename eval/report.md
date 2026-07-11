# ClearClass — Evaluation Report (U10)

Generated 2026-07-11T15:46:59.111Z over the 200-row flexifyai test split. Each suite is run in both retrieval modes — `dense` (the U5 baseline) and `hybrid+rerank` (the U9 advanced arm) — against identical inputs, so the delta columns isolate the Task-6 retrieval change.

## AE4 — leakage guard

✅ **Clean.** 300 retrievable ruling(s) checked; none describe the same product as a test-split row above the 0.5 similarity threshold. No test answer is readable back from the corpus.

## 1. Retrieval recall@k — the primary Task-6 signal

Fraction of test rows whose gold HTS code was surfaced in the top-k retrieved chunks, with NO agent and NO LLM synthesis. This isolates the retrieval change: a real gain here is the cleanest before/after evidence, because the LLM step downstream can mask it.

| metric | dense (baseline) | hybrid+rerank (advanced) | Δ |
| --- | --- | --- | --- |
| recall@5 (≥6-digit) | 34.5% | 39.5% | +5.0 pts |
| recall@10 (≥6-digit) | 42.5% | 48.5% | +6.0 pts |
| recall@20 (≥6-digit) | 50.0% | 52.0% | +2.0 pts |
| recall@5 (≥10-digit) | 20.5% | 26.0% | +5.5 pts |
| recall@10 (≥10-digit) | 29.5% | 37.0% | +7.5 pts |
| recall@20 (≥10-digit) | 38.0% | 41.0% | +3.0 pts |

**Headline:** hybrid+rerank moves recall@10 at ≥10-digit by +7.5 pts over the dense baseline (the largest of 6 recall@k cells — read the full table above, not this cell alone).

## 2. End-to-end classification accuracy

Deterministic exact-match scoring of the full agent loop (retrieve → reason → rank). `top-1 exact` is the best-ranked candidate; `top-3 recall` is any of the three ranked candidates. A row the agent declines (no defensible corpus-backed code) is scored as a MISS, not excluded.

_End-to-end suite not run in this pass._

## 3. RAG quality metrics (autoevals, LLM-judged)

Braintrust `autoevals` RAGAS-ported scorers on a 10-row subset (LLM-judged, so slower and noisier than the deterministic suites above — kept small and separate by design; each metric averages only its non-null judgments).

_RAG-metrics suite not run in this pass._

