# ClearClass — Evaluation Report (U10)

Generated 2026-07-11T23:59:34.366Z over the 200-row flexifyai test split. Each suite is run in both retrieval modes — `dense` (the U5 baseline) and `hybrid+rerank` (the U9 advanced arm) — against identical inputs, so the delta columns isolate the Task-6 retrieval change.

**Agent re-selection (Task 6.3):** `off` for the end-to-end + RAG suites — the agent-side lever that re-ranks the model's own three candidates by their supporting chunk's retrieval position. For a fixed model output it is a pure permutation (top-3 set unchanged), so across an OFF vs ON pair `top-1 exact` carries the effect while `top-3 recall` moves only within model-sampling noise; compare this run's top-1 against a run with the opposite setting.

## AE4 — leakage guard

✅ **Clean.** 2000 retrievable ruling(s) checked; none describe the same product as a test-split row above the 0.5 similarity threshold. No test answer is readable back from the corpus.

## 1. Retrieval recall@k — the primary Task-6 signal

Fraction of test rows whose gold HTS code was surfaced in the top-k retrieved chunks, with NO agent and NO LLM synthesis. This isolates the retrieval change: a real gain here is the cleanest before/after evidence, because the LLM step downstream can mask it.

| metric | dense (baseline) | hybrid+rerank (advanced) | Δ |
| --- | --- | --- | --- |
| recall@5 (≥6-digit) | 35.0% | 40.0% | +5.0 pts |
| recall@10 (≥6-digit) | 42.0% | 49.0% | +7.0 pts |
| recall@20 (≥6-digit) | 48.0% | 52.0% | +4.0 pts |
| recall@5 (≥10-digit) | 21.0% | 27.5% | +6.5 pts |
| recall@10 (≥10-digit) | 29.0% | 35.5% | +6.5 pts |
| recall@20 (≥10-digit) | 36.0% | 40.5% | +4.5 pts |

**Headline:** hybrid+rerank moves recall@10 at ≥6-digit by +7.0 pts over the dense baseline (the largest of 6 recall@k cells — read the full table above, not this cell alone).

## 2. End-to-end classification accuracy

Deterministic exact-match scoring of the full agent loop (retrieve → reason → rank) — rows scored per mode — dense: 197, hybrid+rerank: 199. `top-1 exact` is the best-ranked candidate; `top-3 recall` is any of the three ranked candidates. A row the agent declines (no defensible corpus-backed code) is scored as a MISS, not excluded.

| metric | dense (baseline) | hybrid+rerank (advanced) | Δ |
| --- | --- | --- | --- |
| top-1 exact (≥10-digit) | 18.3% | 20.6% | +2.3 pts |
| top-1 exact (≥6-digit) | 33.0% | 35.7% | +2.7 pts |
| top-1 exact (≥4-digit) | 44.2% | 45.2% | +1.1 pts |
| top-3 recall (≥10-digit) | 25.4% | 29.6% | +4.3 pts |
| top-3 recall (≥6-digit) | 42.1% | 44.7% | +2.6 pts |
| top-3 recall (≥4-digit) | 54.3% | 52.3% | -2.1 pts |

> **Confidence caveat:** at n=200, a binomial 95% CI is roughly ±7%. A small end-to-end delta may be within noise even when recall@k clearly improves — which is why the Task-6 claim leads with recall@k above, not this table.

## 3. RAG quality metrics (autoevals, LLM-judged)

Braintrust `autoevals` RAGAS-ported scorers on rows scored per mode — dense: 37, hybrid+rerank: 36 (LLM-judged, so slower and noisier than the deterministic suites above — kept small and separate by design; each metric averages only its non-null judgments).

> **AnswerRelevancy note:** we keep autoevals' question generation but recompute the score as the mean **raw** cosine between each generated question and the query. Stock `autoevals` runs that cosine through `EmbeddingSimilarity`'s hardcoded 0.7 floor (`(cos − 0.7) / 0.3`, clamped), which collapses genuinely-relevant question↔description pairs (~0.48 cosine) to 0 on every row — RAGAS itself uses the unfloored cosine. See `eval/run.ts#answerRelevancy`.

| metric | dense (baseline) | hybrid+rerank (advanced) | Δ |
| --- | --- | --- | --- |
| Faithfulness | 27.1% | 26.5% | -0.6 pts |
| AnswerRelevancy | 51.7% | 51.6% | -0.1 pts |
| ContextPrecision | 70.3% | 77.8% | +7.5 pts |
| ContextRecall | 5.4% | 6.8% | +1.5 pts |

