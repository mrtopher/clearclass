---
name: ClearClass
last_updated: 2026-07-08
---

# ClearClass Strategy

## Target problem

Licensed customs brokers must assign every imported product a correct Harmonized
Tariff Schedule (HTS) code and duty rate, but classification is a judgment-heavy
task requiring reconciliation of dense tariff rules, prior CBP rulings, and
specific product attributes — and a wrong code means fines, shipment delays, or
over/under-paid duty.

## Our approach

We win by grounding every classification in citable authority — the General Rules
of Interpretation, the live tariff schedule, and actual CBP rulings — and never
returning a code without the reasoning and sources behind it, so a broker can
trust the answer because they can defend it.

## Who it's for

**Primary:** Licensed customs broker / import compliance specialist — they're
hiring ClearClass to classify a new or ambiguous product quickly *and* defensibly,
landing on the right HTS code with reasoning they can stand behind if CBP asks.

## Key metrics

- **Classification accuracy** — % of test products whose suggested HTS code matches
  ground truth (exact, plus partial credit to the heading level); measured in the eval harness.
- **Citation groundedness** — % of answer claims supported by a retrieved source
  (RAGAS faithfulness); the direct measure of defensibility.
- **Retrieval recall@k** — whether the correct ruling/tariff line appears in retrieved
  context; the dial tuned during advanced-retrieval work.
- **Broker acceptance rate** — % of suggestions accepted without override; the real-use
  signal of trust, from app logs / qualitative review.

## Tracks

### Grounded retrieval

The corpus and retriever over the HTS schedule, CBP rulings, GRI, and past entries,
including the advanced-retrieval technique.

_Why it serves the approach:_ The citations that make an answer defensible come from here.

### Agentic reasoning

The agent that applies GRI logic and decides when to consult the live tariff/rulings
(search) versus the private corpus (RAG), producing a code plus its justification.

_Why it serves the approach:_ The reasoning trace is what a broker defends to CBP.

### Evaluation & trust harness

Ground-truth dataset, accuracy/faithfulness metrics, and regression tracking.

_Why it serves the approach:_ Proves the answer is right and catches regressions before they ship.

### Broker workflow

The phone/laptop browser UI, per-importer memory, and the human-approval step.

_Why it serves the approach:_ Defensibility requires a human who can stand behind the call, so the broker stays in the loop.

## Milestones

- **2026-07-14** — Certification Challenge submission (deployed prototype + eval harness + write-up + Loom demo).
- **2026** — Demo Day (date TBD).

## Not working on

- Fully-automated auto-filing — the human broker stays in the loop by design.
- Non-US or export classification — US import HTS only in v1.
- Competing on raw speed — defensibility is the wedge, not latency.
