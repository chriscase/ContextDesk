# Import outcome contract fixtures

Checked-in **synthetic only** member bodies for the batch-corpus import result
contract (`cd_core::log_analysis::import_outcome`) regression tests in
`crates/cd-core/tests/import_outcome_contract.rs`. No private, customer, or
company data; no credentials, hostnames, or gateway references.

| File | Purpose |
|------|---------|
| `members/neighbour-alpha.log` | Plain-text member that must import cleanly beside a defective one |
| `members/neighbour-beta.jsonl` | Well-formed JSON Lines member, all records valid |
| `members/malformed.jsonl` | JSON Lines member with valid records at lines 1 and 4 and malformed records at lines 2 and 3 |

Tests treat these as immutable inputs and fail if any is missing. Archives are
assembled at test time into temporary directories — archive construction never
writes into this checked-in tree, matching `fixtures/import-diagnose`.

The malformed member is deliberately *interleaved*: a defect at line 2 sits
between records that parse. That shape is what proves a located defect does not
imply the surrounding records were dropped, and that neighbouring members in the
same archive still import.
