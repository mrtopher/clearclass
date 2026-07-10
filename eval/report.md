# ClearClass — Evaluation Report (U10)

> **⏳ Not yet generated on live infrastructure.** This file is the committed
> placeholder for the artifact `npm run eval` produces. The U10 harness and its
> unit tests are complete and green; the live run is a deliberate, budgeted step
> (it spends LLM/rerank/Tavily credits and needs the Insforge DB awake), so it is
> triggered explicitly rather than on every build. Running the command below
> **overwrites this file** with the real baseline-vs-advanced results.

## How to generate

```bash
# Full report — both retrieval modes, all three suites (the submission artifact):
npm run eval -- --e2e-limit=200 --rag-limit=40

# Cheap Task-6 headline only (recall@k, no LLM, no rerank spend beyond retrieval):
npm run eval -- --recall-only

# Sampled default (fast sanity pass): recall over all 200, e2e on 25, RAG on 10:
npm run eval
```

Flags: `--modes=dense|hybrid+rerank` (default both), `--limit=<n>` (cap all
suites), `--e2e-limit=<n>` / `--rag-limit=<n>` (cap the expensive suites),
`--k=5,10,20`, `--skip-e2e`, `--skip-rag`, `--out=<path>`. Requires the same
credentials as `npm run eval:recall` (Insforge admin config + the LLM gateway
key); `hybrid+rerank` additionally uses `COHERE_API_KEY` (it degrades to
fused-hybrid order without one).

## What the generated report contains

Each suite runs in **both** retrieval modes against identical inputs — `dense`
(the U5 baseline) and `hybrid+rerank` (the U9 advanced arm) — so the Δ columns
isolate the Task-6 retrieval change. Section order encodes the U10 Execution
note: lead with recall@k, not end-to-end accuracy.

- **AE4 — leakage guard.** Runs *first* and aborts the whole run on any
  violation: it re-applies the U3 ingest-time product-similarity guard against
  the rulings actually retrievable from the corpus, proving no test answer can be
  read back. A failed guard invalidates every number below it.

- **1. Retrieval recall@k — the primary Task-6 signal.** Fraction of test rows
  whose gold HTS code was surfaced in the top-k retrieved chunks, with no agent
  and no LLM synthesis, at ≥6- and ≥10-digit precision. This is the cleanest
  before/after evidence because it isolates retrieval from the LLM step (which
  can mask a real retrieval gain in the final code). The baseline this must beat
  is the U5 dense recall (6-digit r@20 ≈ 0.50, 10-digit r@20 ≈ 0.38).

- **2. End-to-end classification accuracy.** Deterministic exact-match scoring of
  the full agent loop — top-1 exact and top-3 recall at 10-, 6-, and 4-digit
  precision (R12). Reported with an n-scaled 95% confidence caveat (at n=200,
  ≈±7%): a small end-to-end delta may be within noise even when recall@k clearly
  improves, which is why the Task-6 claim leads with recall@k.

- **3. RAG quality metrics.** Braintrust `autoevals` RAGAS-ported LLM-as-judge
  scorers (Faithfulness, AnswerRelevancy, Context precision/recall) on a ~40-row
  subset — kept small and separate because they are slower and noisier than the
  deterministic suites.

After the run confirms the lift, flip production to the advanced arm with
`RETRIEVAL_MODE=hybrid+rerank` (defaults to `dense` until then).
