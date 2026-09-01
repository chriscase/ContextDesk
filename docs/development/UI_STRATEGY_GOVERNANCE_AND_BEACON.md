# UI Strategy Governance V1 and Beacon pilot

Status: local integration candidate on `integrate/beacon-strategy-governance-v1`.
This document does not claim the candidate is merged or deployed.

## Outcome

This slice adds one server-governed rollout boundary and one new presentation
strategy:

- **UI Strategy Governance V1** controls which registered investigation
  experiences are enabled, visible, selectable, and defaulted for the instance
  and for the highest group-derived ContextDesk role.
- **Beacon / Rapid Intake** is an append-first triage experience for creating a
  sparse investigation, recording dated observations and next actions,
  attaching logs/emails/files, and explicitly promoting reviewed information
  into the Situation or a cited hypothesis.

Neither feature owns case access, evidence authority, lifecycle, retention,
storage, audit, or transport. Those remain server and Runtime responsibilities.

## Governance scopes

| Scope | Stored rule | Authority |
|---|---|---|
| Instance | enabled, visible, default, selection mode, approved subset | `admin:system_config` |
| Role | approved subset and optional default for Viewer, Contributor, Case lead, Administrator | group-derived ContextDesk roles; highest role wins |
| User | one preferred strategy and independent revision | authenticated internal identity ID |
| Strategy | closed ID, registry metadata, maturity, compatibility, optional presentation features | build-time registry plus server contract |

Raw LDAP group names are deliberately not strategy rules. Directory groups map
to ContextDesk roles through the existing authorization boundary; strategy
policy consumes only those roles.

## Safe defaults and recovery

- War Room is always enabled and remains the reference/recovery surface.
- The bootstrap policy enables War Room, Investigation First, and Keystone;
  Beacon starts hidden.
- Unknown or malformed policy data makes the browser use War Room only and
  disables personal selection.
- Old `cd-ui-strategy:*` browser values are neither imported nor deleted. They
  are not authority.
- A temporary “Open War Room technical tools” handoff is scoped to browser
  history and does not overwrite the personal server preference.
- An empty approved subset is valid and fixes users to the applicable default.

## HTTP contracts

All successful bodies are strict versioned contracts. Browser mutations use
the existing CSRF boundary. Authentication loss retains the existing 401/403
behavior; policy conflicts and disallowed selection use 409 so they cannot be
misinterpreted as session loss.

| Route | Capability | Purpose |
|---|---|---|
| `GET /api/ui-strategies/effective` | authenticated session | resolved policy and personal preference |
| `PUT /api/ui-strategies/preference` | authenticated session | revision-checked personal choice |
| `GET /api/admin/ui-strategies` | `admin:system_config` | current instance/role policy |
| `PUT /api/admin/ui-strategies` | `admin:system_config` | revision-checked audited policy mutation |

Policy and preference writes are compare-and-swap operations. PostgreSQL holds
the policy advisory lock and writes policy history and audit in the same
transaction. SQLite uses one composite transaction across governance state and
raw audit state. A successful mutation is never reported unless its success
audit is committed with it.

## Beacon interaction contract

Beacon imports only the public Investigation Runtime and the shared strategy
presentation kit.

1. **Create and open** calls `createInvestigation` once. Sparse optional fields
   remain valid and display as not recorded.
2. **Record entry** calls `createContribution` once for the user-chosen
   observation, update, or next action. The dated server record is appended.
3. **Attach evidence** calls `uploadEvidence` once and uses the same evidence
   storage provider as every other strategy, including S3-compatible storage.
4. **Promote to Situation** is a second explicit user action and calls
   `updateSituation`; the runtime derives the expected Situation revision and
   never retries a conflict automatically.
5. **Record hypothesis** is a separate contribution. When the user selects a
   source entry, Beacon sends an explicit contribution citation and leaves the
   original entry intact.

There is no automatic append-and-promote chain, background write, fabricated
priority, inferred SLA, browser-persisted draft, or private API route.

## Administrator workflow

Open **Administration → Investigation experiences**. The shell exposes this tab
to `admin:system_config`; user/directory tabs remain separately gated by
`admin:users`.

For each strategy an administrator can:

- enable the strategy runtime registration;
- show or hide it in the personal selector;
- choose the instance default;
- allow free choice among visible strategies or restrict choice;
- set instance and role approved subsets;
- optionally set a role default.

Saving sends the revision that was loaded. A concurrent update refuses with a
refresh instruction instead of overwriting the other administrator.

## Qualification gates

The candidate must not be called shipped until all of these are true:

- contract, migration, memory, SQLite, PostgreSQL-structure, route, shell,
  governance hook, Beacon workflow, and registry/conformance tests pass;
- full contracts/server/web suites, typecheck, lint, and production builds pass;
- browser qualification covers policy rollout, personal choice, Beacon create,
  append, evidence upload, Situation promotion, cited hypothesis, read-only,
  denied/no-read, narrow reflow, forced colors, and reduced motion;
- a fresh independent review finds no P0/P1 issue;
- the protected PR is green and merged before any release claim.

## Deliberate follow-ups

- LDAP-group-specific strategy rules; role rules cover the first milestone.
- User-facing policy history. Every provider stores durable success audit
  records; PostgreSQL also stores append-only policy snapshots in revision
  order. Cross-provider snapshot history is a deliberate follow-up.
- Recoverable trash and retention automation.
- Larger corpus/log intake beyond the bounded evidence upload command.
- Shared autocomplete catalogs and administrator value deduplication.
