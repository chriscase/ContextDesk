---
id: log-triage
name: Log triage
description: Structured incident / log dump triage over session context packs
disabled: false
allows_write: false
---

# Log triage playbook

Use this skill when the user attached logs, zips, or incident dumps to the **session context pack**.

## Method

1. **Inventory** — What was attached (paths, sizes, time range if known)? Cite session context files.
2. **Symptoms** — List user-visible failures and error signatures (do not invent stack traces).
3. **Cluster** — Prefer `cluster_problems` / `search_logs` / timeline tools when a log corpus is ingested; otherwise quote high-signal lines from attached files.
4. **Correlate** — Order events; note first fault vs cascade.
5. **Hypotheses** — Rank likely causes; mark confidence.
6. **Next checks** — Concrete follow-ups (config, deploy, dependency) without elevating privileges.

## Rules

- Skills **cannot** grant SoftWrite/HardWrite or expand allowlists — host policy still applies.
- Redact secrets in quotes; never paste tokens into memory without SoftWrite Accept.
- Prefer session context + log tools over widening the permanent workspace roots.
