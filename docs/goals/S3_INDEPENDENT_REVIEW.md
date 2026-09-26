# S3 independent adversarial review

## Recovery review

Fresh separate same-model reviewer `/root/s3_review`, read-only inspection of
the inherited dirty recovery state above `5152655c480a524130d1a280056ca9a74ecb9e7a`.
The reviewer did not execute tests or submit a GitHub approval. This was not
cross-model review.

Exact inspected `s3-store.ts` SHA-256:
`473b3ae2e0a978e263d8b63be2d6843d4198a98d40c8ccacd04f747ae2b1a0fc`;
SDK test SHA-256:
`81739457b945ddbfa9d11f2b88ccd25dd055ff1d7384938bca25e2881a0f827e`.

| Finding | Candidate disposition |
|---|---|
| Production opaque S3 adapter hid direct-client retry configuration; copy could use normal multi-attempt client | Scoped canonical-copy capability added through production opaque provider; actual installed-SDK handler counts prove one attempt under retry overrides. |
| Swallowed copy errors plus missing HEAD could turn uncertain dispatch into absence and erase pending journal | Dispatch witness and stage-specific classification preserve uncertainty even with missing HEAD; separate conservative internal retention flag. |
| Stage commit/batch promote could directly replay an unresolved copy | Verification-only retained ownership path; stream failed-promotion guard retained; no further canonical dispatch. |
| Retried cleanup reacquired lease without reloading references and could delete newly adopted content | Reload authoritative bound references under reacquired lease before deletion; adoption-between-cleanup-attempts regression. |
| SDK fixture did not cover lost/truncated response, and reopen proof was absent | File-backed installed-SDK fixture, response-stage faults, bounded reads/copy counts, fresh object-provider construction and reopened SQLite with/without adoption. |

## Final candidate review

Requested after publication of functional candidate C. Exact revision/tree,
execution status, findings and residuals will be recorded here in an evidence-only
follow-up, and remain distinct from GitHub review approval.
