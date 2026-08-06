---
id: logging-quality-assessment
title: Logging quality assessment
summary: After import, score durable log quality with fixed, evidence-backed improvement hints — no LLM required.
section: log-analysis
tags:
  - logs
  - quality
  - demo
order: 6
related:
  - demo-log-datasets
  - log-analysis-pipeline
---

# Logging quality assessment

![Log analysis pipeline from ingest through redaction and analysis](../assets/log-analysis-pipeline.svg)

ContextDesk can score an **already imported** corpus for engineering log
quality. The result is a versioned
`contextdesk.logging_quality_assessment.v1` document with **fixed template
improvement hints per finding code**. This is not a free-form or
model-generated “Engineering Improvement Plan.”

The assessment is deterministic, demo-safe, and provider-free. CLI, desktop,
and any future API host consume the same DTO from `cd-core` (pure assessor)
via `cd-workflow` (orchestration and atomic report write).

## What it measures (v1)

Only facts recomputable from durable corpus state:

| Family | Durable source |
| --- | --- |
| Timestamp certainty | Provenance / active basis / unresolved locals |
| Selection coverage | Distinct selected / ignored / unsupported / excluded / failed buckets |
| Parse structure | Durable `format_counts` |
| Stored-level honesty | Normalized level vocabulary (not severity provenance) |
| Noise concentration | Review-only template share / HHI (never verified noise) |
| Trace coverage | Parser-true `trace_id` only |

Multiline quality is **omitted** in v1 because ingest does not persist
quantified multiline counters.

## Non-claims

The report never claims: UTC/wall inference beyond durable counters, root
cause, confirmed noise, OTel compliance, universal parse success, or
tracing readiness.

## Demo script (synthetic fixtures only)

```sh
DATA="$(mktemp -d)"
FIX=fixtures/log-lab/scenarios/mixed-time-quality/import

contextdesk --data-dir "$DATA" import "$FIX"
ID=$(contextdesk --data-dir "$DATA" --json corpus list | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["corpora"][0]["id"])')

contextdesk --data-dir "$DATA" logging-assessment "$ID"
contextdesk --data-dir "$DATA" --json logging-assessment "$ID" | python3 -m json.tool | head

contextdesk --data-dir "$DATA" --json logging-assessment "$ID" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]["assessment"];
print("grade", d["summary"]["grade"]);
[print(f["id"], "→", f["improvementHint"]["templateId"], f["evidence"][0]["key"]) for f in d["findings"][:5]]'

contextdesk --data-dir "$DATA" logging-assessment "$ID" \
  --report-format markdown --output "$DATA/plan.md"
```

Or: `./scripts/demo-logging-quality.sh`

## Five layers on every finding

1. Measured fact
2. Deterministic finding
3. Fixed improvement hint (template id + acceptance criteria)
4. Evidence reference
5. Confidence / limitations

Limitations are mandatory whenever residual uncertainty applies.

## Exit behavior

| Situation | Exit |
| --- | --- |
| Assessment completed (any grade) | `0` |
| Bad flags / unsupported format / output exists | `1` (`user_error`) |
| Corpus id missing | `3` (`not_found`) |

Atomic export: stage → validate JSON schema → publish with noclobber. Failed
or cancelled publication leaves no report at the destination.
