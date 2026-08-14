# Retrieval ablation — small tier (10983 events)

ContextDesk `7b8638f655ff68342f7f6d426a49cbb36c7e3b52` · suite v1 · generator `contextdesk.log_lab.retrieval_ablation.generator.v1` · seed `92026080701` · corpus `254db715b5851e29`

| Mode | Recall@25 | Rare trigger | Decoy rate | Runtime |
|------|-----------|--------------|------------|---------|
| Structured + keyword | 0.710 | 0.583 | 0.050 | 825 ms |
| + semantic embedding | FUTURE_CAPABILITY_UNAVAILABLE | FUTURE_CAPABILITY_UNAVAILABLE | FUTURE_CAPABILITY_UNAVAILABLE | — |
| + reranking | FUTURE_CAPABILITY_UNAVAILABLE | FUTURE_CAPABILITY_UNAVAILABLE | FUTURE_CAPABILITY_UNAVAILABLE | — |
| + bounded multi-stage analysis | FUTURE_CAPABILITY_UNAVAILABLE | FUTURE_CAPABILITY_UNAVAILABLE | FUTURE_CAPABILITY_UNAVAILABLE | — |

## Partition

- BASELINE_LIMITATION: 5
- FUTURE_CAPABILITY_UNAVAILABLE: 60
- PASS_ON_BASE: 15

## Cases

| Case | Probe | structured_keyword | Notes |
|------|-------|--------------------|-------|
| rb01-lexical-easy | control: query and causal evidence share obvious terminology | PASS_ON_BASE | recall@25 1.000, decoy 0.000 |
| rb02-semantic-gap | query vocabulary (database availability) never appears in causal evidence (JDBC / IceCube / managed-connection vocabulary) | BASELINE_LIMITATION | recall@25 0.500, decoy 0.000 |
| rb03-rare-causal | a handful of causal records hide inside a high-volume wildcard template family | BASELINE_LIMITATION | recall@25 0.611, decoy 0.000 |
| rb04-frequency-decoy | thousands of high-severity repetitive errors compete with a small shutdown cascade | BASELINE_LIMITATION | recall@25 0.417, decoy 1.000 |
| rb05-cross-source | trigger, propagation, symptoms and recovery use different vocabulary in database, app server, worker and client logs | PASS_ON_BASE | recall@25 0.917, decoy 0.000 |
| rb06-duplicate-renderings | one failure appears as a multiline application exception plus hundreds of separately wrapped stderr records | PASS_ON_BASE | recall@25 1.000, decoy 0.000 |
| rb07-interleaved | similar exceptions from unrelated threads/requests must remain separate | PASS_ON_BASE | recall@25 1.000, decoy 0.000 |
| rb08-rotations-nested | rotated suffixes, nested directories with shared basenames, and ZIP/folder parity keep stable source identity | PASS_ON_BASE | recall@25 0.667, decoy 0.000 |
| rb09-time-uncertainty | ambiguous local time, mixed offsets, DST ambiguity and order-only records must not yield invented cross-source chronology | PASS_ON_BASE | recall@25 1.000, decoy 0.000 |
| rb10-competing-roots | two equally supported explanations must both survive retrieval and analysis | PASS_ON_BASE | recall@25 0.833, decoy 0.000 |
| rb11-missing-trigger | only symptoms are present; the root cause must remain unknown | PASS_ON_BASE | recall@25 0.583, decoy 0.000 |
| rb12-semantic-near-miss | highly similar messages belong to different services and incidents; embeddings must not merge them | PASS_ON_BASE | recall@25 0.833, decoy 0.000 |
| rb13-multilingual | terminology-varied and non-English records measure multilingual retrieval without making language the answer | BASELINE_LIMITATION | recall@25 0.417, decoy 0.000 |
| rb14-secrets-malformed | credential-shaped values, malformed Unicode, binary noise and markup distractions | PASS_ON_BASE | recall@25 0.667, decoy 0.000 |
| rb15-recovery-evidence | startup/ready/recovery records follow failures; trigger, propagation, symptom and recovery must stay distinct | PASS_ON_BASE | recall@25 0.667, decoy 0.000 |
| rb16-search-non-progress | cosmetically different but equivalent searches must return identical evidence; workflows must change strategy or stop | PASS_ON_BASE | recall@25 1.000, decoy 0.000 |
| rb17-provider-interruption | retrieval quality stays distinct from transport failure and semantic-attempt failure | PASS_ON_BASE | recall@25 0.750, decoy 0.000 |
| rb18-template-heterogeneity | rare operationally material events share one wildcard-heavy template with repetitive noise and must remain retrievable | BASELINE_LIMITATION | recall@25 0.167, decoy 0.000 |
| rb19-severity-isolated | a dramatic FATAL record unrelated to the incident must not outrank a supported causal chain | PASS_ON_BASE | recall@25 0.500, decoy 0.000 |
| rb20-partial-corpus | retention gaps prevent complete analysis; exact totals and complete coverage must not be claimed | PASS_ON_BASE | recall@25 0.667, decoy 0.000 |

