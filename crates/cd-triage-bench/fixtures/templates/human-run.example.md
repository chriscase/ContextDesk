<!--
Worked example: human expert write-up (synthetic).

Replace REPLACE_WITH_TASK_ID with the id printed by `import-task`.
This example uses unknown prompt/workflow/cost/timing on purpose.
Cited evidence ids are claims only — import does not resolve them.
-->

```json
{
  "schema_id": "contextdesk.triage_bench.run_import.v1",
  "task_id": "REPLACE_WITH_TASK_ID",
  "strategy": {
    "name": "human-expert",
    "version": { "status": "unknown" },
    "build": { "status": "unknown" }
  },
  "source_kind": "human",
  "prompt_workflow": {
    "completeness": "unknown",
    "prompt": { "status": "unknown" },
    "workflow": { "status": "unknown" }
  },
  "claims": [
    {
      "claim": "inventory client timeout",
      "evidence_item_id": "ev-log-1",
      "locator": "ERROR checkout failed"
    }
  ],
  "timing": { "status": "unknown" },
  "cost": { "status": "unknown" },
  "uncertainty": {
    "status": "known",
    "value": "timeout is in the log; lock contention is not in the snapshot"
  },
  "fairness": { "kind": "same_snapshot" },
  "status": "completed",
  "operator": "alex-oncall",
  "importer": "bench-operator",
  "privacy": "share_safe",
  "created_at": "2026-01-15T08:00:00Z"
}
```
Diagnosis: the checkout 500s match an inventory client timeout in the visible log.

I would raise the client timeout and watch the error rate. I am not certain the lock-contention story is in evidence.

Cited: ev-log-1 (inventory timeout line).
