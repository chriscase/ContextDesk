<!--
contextdesk.triage_bench.run_import.v1 — human submission template

Fill the JSON metadata. Unknown fields stay {"status":"unknown"} — do not
invent versions, prompts, costs, or timing. Fairness is required at import
and cannot be edited later.

The verbatim result starts on the first line after the closing fence.
That body is stored byte-exact: only the single newline after ``` is skipped.
Do not edit a run after import; a correction is a new run.

Worked example: human-run.example.md
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
  "timing": { "status": "unknown" },
  "cost": { "status": "unknown" },
  "uncertainty": { "status": "unknown" },
  "fairness": { "kind": "same_snapshot" },
  "status": "completed",
  "operator": "expert-name",
  "importer": "importer-name",
  "privacy": "owner_only",
  "created_at": "2026-01-15T08:00:00Z"
}
```
PASTE_VERBATIM_RESULT_HERE
