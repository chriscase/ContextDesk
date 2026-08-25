# Synthetic release-contract fixtures

These scenarios are built in-process by
`scripts/release-contract/release_contract.py` (`populate_complete_matrix`)
and asserted by `scripts/release-contract/check_release_contract.py`.
They use public placeholder bytes only — no real installers, private data,
or secret material.

| Scenario | Expected |
|----------|----------|
| complete GA matrix + bound `latest.json` | assemble + promotable |
| missing Windows installer or CLI platform | assemble fails |
| Cargo/tag version mismatch | identity fails |
| `build-info` git SHA ≠ identity | assemble fails |
| missing / placeholder / wrong-bytes signatures | assemble fails |
| duplicate basename or two CLI archives for one OS | assemble fails |
| `v0.1.0-rc5` archive or `latest.json` URL | assemble / verify fails |
| second writer changes title/body/prerelease | clobber rejected; original kept |
| promote without confirm, with wrong SHA, or after ripping `latest.json` | draft stays unpublished |
