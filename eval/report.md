# ClearClass — Evaluation Report (U10)

Generated 2026-07-11T16:53:26.381Z over the 200-row flexifyai test split. Each suite is run in both retrieval modes — `dense` (the U5 baseline) and `hybrid+rerank` (the U9 advanced arm) — against identical inputs, so the delta columns isolate the Task-6 retrieval change.

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

Deterministic exact-match scoring of the full agent loop (retrieve → reason → rank) — rows scored per mode — dense: 199, hybrid+rerank: 200. `top-1 exact` is the best-ranked candidate; `top-3 recall` is any of the three ranked candidates. A row the agent declines (no defensible corpus-backed code) is scored as a MISS, not excluded.

| metric | dense (baseline) | hybrid+rerank (advanced) | Δ |
| --- | --- | --- | --- |
| top-1 exact (≥10-digit) | 19.6% | 20.0% | +0.4 pts |
| top-1 exact (≥6-digit) | 34.2% | 37.0% | +2.8 pts |
| top-1 exact (≥4-digit) | 45.2% | 46.5% | +1.3 pts |
| top-3 recall (≥10-digit) | 25.1% | 30.5% | +5.4 pts |
| top-3 recall (≥6-digit) | 41.7% | 48.5% | +6.8 pts |
| top-3 recall (≥4-digit) | 53.8% | 60.0% | +6.2 pts |

> **Confidence caveat:** at n=200, a binomial 95% CI is roughly ±7%. A small end-to-end delta may be within noise even when recall@k clearly improves — which is why the Task-6 claim leads with recall@k above, not this table.

## 3. RAG quality metrics (autoevals, LLM-judged)

Braintrust `autoevals` RAGAS-ported scorers on rows scored per mode — dense: 39, hybrid+rerank: 38 (LLM-judged, so slower and noisier than the deterministic suites above — kept small and separate by design; each metric averages only its non-null judgments).

| metric | dense (baseline) | hybrid+rerank (advanced) | Δ |
| --- | --- | --- | --- |
| Faithfulness | 21.5% | 30.3% | +8.8 pts |
| AnswerRelevancy | 0.0% | 0.0% | +0.0 pts |
| ContextPrecision | 69.2% | 78.9% | +9.7 pts |
| ContextRecall | 7.2% | 9.7% | +2.6 pts |

