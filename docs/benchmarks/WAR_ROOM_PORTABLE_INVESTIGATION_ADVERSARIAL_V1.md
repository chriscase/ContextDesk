# Portable investigation V1 adversarial qualification

Status: **contract lab only**. This record qualifies the shipped parse / canonicalize /
fingerprint / hash / dry-run preflight functions in
`collab/contracts/src/investigation-portable.ts`. It does **not** implement or
claim import apply, persistence, destination authorization, routing, or UI.

Fixtures in the lab are **fully synthetic**: fictional installation
`inst-synthlab0001`, operators `operator-north` / `reviewer-west`, and
fictional excerpts. No live logs, exports, hostnames, customer names, or
derived excerpts.

## What the lab drove

Hostile `structuredClone` mutations against a complete sealed synthetic bundle,
calling:

- `parsePortableInvestigation`
- `attachPortableIntegrity`
- `canonicalizePortableInvestigation`
- `portableBundleFingerprint`
- `computePortableObjectHashes`
- `preflightPortableInvestigation`

## Matrix

| Class | Result on the repaired parser |
| --- | --- |
| Unknown fields at every major nesting | fail-closed (`unknown key`) |
| Missing / duplicated / substituted / cross-namespace object hashes | fail-closed |
| Reordered bags and hash entries | identical canonical fingerprint |
| Duplicate ids and dangling refs, including all 18 timeline namespaces and null parity | fail-closed |
| Gold identity/version uniqueness, adjacency, self-reference, cycles, missing predecessors, and forks | fail-closed |
| Snapshot fingerprint, ordinal, privacy, fairness, lineage, self-parent | fail-closed |
| Content digest / length / payload / duplicate digest | fail-closed |
| Credential, directory-protocol, URL, path, token leakage in opaque keys and values | fail-closed |
| Display-name / email matching never authorizes; conflicting maps fail; `applyAuthorized` stays false | hold |
| Destination id collisions: `fail` blocks; `remap_deterministic` is stable, namespaced, order-independent, skips occupied candidates, and fails closed on bounded exhaustion | hold |
| Unicode identifier ordering across host locales / ICU data | locale-independent UTF-16 code-unit order |
| Empty and nested ids reject controls while ordinary prose retains whitespace | fail-closed |
| Generic provider/model metadata remains historical; usage/cost stay `unknown` | hold |
| Mutating one object changes its object hash and the bundle fingerprint | hold |
| Parse / preflight do not mutate caller-owned input | hold |

## Production repairs proven by this lab

Parent `618b259c` accepted four hostile rows. Smallest fail-closed repairs:

1. Timeline targets have null parity and resolve across every portable object namespace.
2. Gold history is a unique, adjacent, acyclic, single-successor version chain.
3. Opaque JSON keys and values reject URLs and absolute, traversal, home, drive, or network paths.
4. Top-level and nested identifiers reject C0 / DEL / zero-width controls without constraining prose.
5. Deterministic remap candidates cannot overwrite an occupied destination id; bounded exhaustion fails closed.
6. Canonical bags, hashes, fingerprints, remap rows, and identity resolutions use explicit locale-independent UTF-16 code-unit ordering.

## Non-claims / future work

Import apply, persistence, destination authorization, and UI remain future
work. This lab does not call a live provider and does not invent gold, cost, or
usage.
