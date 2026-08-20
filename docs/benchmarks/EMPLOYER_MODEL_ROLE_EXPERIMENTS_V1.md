# Employer-model role experiments v1

Status: protocol and reporting template. This document does not certify any
model, role, provider, or release.

## Question

How much does model choice matter when the task, evidence packet, host
validation, budget, and role contract stay fixed?

The experiment must distinguish:

- reasoning and evidence quality;
- structured-output and role-contract reliability;
- latency, provider calls, timeouts, and cost;
- the quality contribution of a role versus the model filling it.

No model is promoted from transport success alone.

## Fixed controls

For every cell, keep these identical:

1. ContextDesk build SHA and host workflow version.
2. Exact case, task, snapshot, packet visibility, and prompt/protocol.
3. Provider-call bound, whole-turn deadline, sampling parameters, and retry
   policy.
4. Host scorer, truth/adjudication material, and repetition count.
5. Privacy and egress acknowledgement.

The evaluator truth stays outside the model-visible packet. The model sees only
the bounded task packet. A run that cannot prove the packet/model binding is
excluded from independent agreement.

## Required employer baseline

Run the exact employer-gateway ids:

| Model | Baseline use |
| --- | --- |
| qwen-3.6-27b | quality-oriented candidate or finalizer |
| gpt-oss-120b | fast bounded contributor |
| ministral-3-14b-instruct-2512 | fast provisional contributor |

Use contextdesk models discover and contextdesk models verify for the exact
profile/model pair. Do not substitute a namespaced id from another gateway or
infer chat capability from a model name.

For each model, run at least:

- one answerable causal task;
- one insufficient-evidence or abstention task;
- one contradiction/decoy task;
- three repeats per task before making a routing recommendation.

## Role-factorial matrix

The first pass should use a small balanced matrix:

| Cell | Observation/contributor | Finalizer | Reviewer | Purpose |
| --- | --- | --- | --- | --- |
| E0 | employer baseline | employer baseline | none | baseline pipeline |
| E1 | Ministral | Qwen | none | cheap contributor, quality finalizer |
| E2 | GPT-OSS | Qwen | none | fast contributor, quality finalizer |
| E3 | Qwen | Ministral | none | quality contributor, cheap finalizer |
| E4 | employer contributor | Grok Build | optional | direct frontier finalizer challenger |
| E5 | Grok Build | Qwen | optional | frontier contributor challenger |
| E6 | employer contributor | Luna | optional | alternate frontier finalizer challenger |
| E7 | Luna | Qwen | optional | alternate frontier contributor challenger |

For a role-factorial run, only the role assignment changes. Do not change the
task or packet between E1 and E2, or between E4 and E5.

The current bench-compare helper directly exercises the standard single-model
candidate lane. Enhanced/Advanced contributor, reviewer, and finalizer cells
must use the host's explicit qualified multi-model policy/configuration. Do
not represent a role assignment by merely renaming a single-model candidate.

## Grok Build and Luna provenance

Grok Build may be used directly and does not need the Vercel gateway. A
frontier challenger is comparable only when it returns a typed
contextdesk.triage.replay.v1 envelope bound to the same packet and carrying
its exact model identity. Ingest that envelope through
cd-triage-bench-adapter record-replay.

If a lane provides only pasted chat text, preserve the bytes with
cd-triage-bench import-run --raw. Record the declared model as an external
label only. It may inform a qualitative review, but it does not count as
independent model corroboration without exact identity and same-packet proof.

The name “Luna” is not itself a model identity. Record the exact model id and
platform/host that produced the output. If the requested ChatGPT/Luna model is
not exposed by the current execution lane, leave that cell pending rather than
substituting a different model.

## Scoring and report

Report every cell with:

- exact profile/model id, qualification/probe evidence, and build SHA;
- run count and terminal statuses;
- host-scored correctness dimensions;
- evidence citation precision and recall;
- symptom/cause/independent-noise separation;
- contradiction and unsupported-claim handling;
- structured-output validity and role dropouts;
- latency, provider calls, timeout, and cost observations;
- owner-only report, plus share-safe projection;
- evidence-agreement anchors, role conflicts, sole support, and independent
  model count.

Agreement is evidence-and-role corroboration, not correctness or majority
vote. A consensus can be jointly wrong; a lone answer can be correct. Keep
those claims separate in the report.

## Promotion rule

Do not promote a model to an unreviewed final-answer role until it has passed
the exact-role compatibility checks and the repeated quality matrix. A
reasonable first gate is three successful answerable repeats, no hard
role-separation violation on the decoy task, and no unexplained structured
output failure. This is a local experiment gate, not a universal model claim.
