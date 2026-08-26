# Administrator model-purpose policy v1

Status: next-release design and implementation contract. This document is not
evidence that the policy is implemented in the current release candidate.

## Why this exists

The War Room currently lets a case lead choose a configured host profile for a
gateway lane. That is useful, but it leaves the most important workspace-level
decision implicit: which approved model may be used for which kind of work.
Administrators need to make that decision once, visibly, and have the server
enforce it for every caller.

The policy is about model use, not credentials. A policy refers only to the
safe catalog identities already exposed by the host. Gateway endpoints,
tokens, headers, raw prompts, and responses remain outside the browser and the
policy store.

## Initial purposes

The first version uses a deliberately small, extensible purpose vocabulary:

| Purpose | Initial consumer | Meaning |
| --- | --- | --- |
| `triage` | War Room lane launcher | A model examines one frozen evidence snapshot for the investigation question. |
| `comparison` | War Room multi-lane run | Multiple approved lanes are run for a deliberate comparison. |
| `summarization` | Future investigation summary/chat assist | A concise navigation or handoff summary, never a decision. |
| `investigation_chat` | Future private/shared investigation conversation | An AI participant may answer in a clearly labeled model turn. |
| `redaction` | Future export and share-safe preparation | A host-approved model may assist redaction; the deterministic privacy gate remains authoritative. |

The UI must label purposes in human language. Technical purpose ids belong in
the policy contract and audit record, not in the primary workflow.

## Policy shape

The durable record is a single current policy with immutable revisions:

```json
{
  "schemaId": "cd-collab.model_purpose_policy.v1",
  "revision": 3,
  "fingerprint": "sha256:…",
  "updatedAt": "2026-08-26T00:00:00.000Z",
  "updatedBy": "uid:admin",
  "purposes": {
    "triage": {
      "enabled": true,
      "allowedSubjects": ["subject:…"],
      "allowedRoles": ["case-lead", "admin"],
      "maxLanes": 3,
      "privateEvidence": "host_policy"
    },
    "comparison": {
      "enabled": true,
      "allowedSubjects": ["subject:…", "subject:…"],
      "allowedRoles": ["case-lead", "admin"],
      "maxLanes": 4,
      "privateEvidence": "host_policy"
    },
    "summarization": {
      "enabled": false,
      "allowedSubjects": [],
      "allowedRoles": [],
      "maxLanes": 1,
      "privateEvidence": "never"
    },
    "investigation_chat": {
      "enabled": false,
      "allowedSubjects": [],
      "allowedRoles": [],
      "maxLanes": 1,
      "privateEvidence": "never"
    },
    "redaction": {
      "enabled": false,
      "allowedSubjects": [],
      "allowedRoles": [],
      "maxLanes": 1,
      "privateEvidence": "never"
    }
  }
}
```

`allowedSubjects` contains the stable catalog subject id, not an arbitrary
model string typed by a user. A subject binds the host profile, provider,
exact model id, and optional version. The server rejects a subject that is not
currently present in the safe host catalog.

`privateEvidence` is intentionally explicit:

- `never`: the purpose may not receive an owner-only snapshot.
- `host_policy`: the trusted host must separately approve the egress; the
  browser cannot grant that approval.

## Enforcement rules

1. The server resolves the current policy at admission time. A client-supplied
   policy fingerprint is never trusted as authorization.
2. The server maps each request to a purpose. Existing gateway triage runs map
   to `comparison` when they contain multiple lanes; a single-lane future
   request maps to `triage`.
3. Every selected subject must be in the purpose allow-list, the requester's
   role must be allowed, the lane count must not exceed `maxLanes`, and the
   private-evidence rule must pass.
4. Any missing policy, unknown subject, stale catalog entry, disabled purpose,
   or policy-store error fails closed with a safe human-readable reason.
5. The admitted job stores the exact policy revision and fingerprint. Later
   edits do not rewrite the historical decision.
6. Recovery re-evaluates the current identity, catalog subject, and policy
   before resuming a queued job. A revoked model or purpose becomes an explicit
   failed recovery, never an implicit continuation.
7. Synthetic/offline fixtures remain available for demo and tests, but they are
   clearly marked provider-free and do not bypass live gateway policy.

## Administration experience

Add a `Model use` tab under Administration. It should show:

- a plain-language explanation that these rules apply to every investigation;
- one card per purpose with an enable switch, approved-model combobox, role
  checkboxes, maximum-lane control, and private-evidence choice;
- catalog labels such as “Company gateway · Qwen 3.6 27B”, never secrets or
  endpoint URLs;
- the current revision, last editor, and whether the host catalog is stale;
- a review step describing the effect before save;
- a clear failure if the server cannot persist or re-read the new revision.

The page must not allow arbitrary model ids, credentials, endpoint editing, or
client-only policy changes. A case lead's lane selector should only show the
intersection of the current purpose policy and the host catalog, with a short
explanation when a model is unavailable.

## Audit and acceptance

Each read, save, rejected save, and rejected run records an audit event with
purpose, policy revision/fingerprint, actor, and safe subject ids. It must not
record prompts, evidence content, URLs, headers, or tokens.

Required tests:

- contract validation, canonical fingerprinting, duplicate subject rejection,
  unknown purpose rejection, and no-secret projection;
- admin authorization and audit behavior for read/save/rejected save;
- fail-closed behavior for disabled purposes, stale subjects, role mismatch,
  private evidence, max lanes, and unavailable persistence;
- queued-job recovery after a policy revision or identity change;
- SQLite restart persistence and PostgreSQL transaction/rollback parity;
- War Room UI filtering and an end-to-end admin save → launcher rejection /
  admission journey;
- privacy scan proving no endpoint, credential, prompt, raw evidence, or model
  response enters the policy API or browser payload.
