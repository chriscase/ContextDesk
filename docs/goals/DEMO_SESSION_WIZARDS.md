# Demo script: Guided log troubleshooting (#442)

## Path

1. Launch ContextDesk desktop (workspace + AI configured).
2. Click **Guided…** next to **+** (or empty-state **Log troubleshooting**, or palette **Guided setup…** / **Log troubleshooting wizard**).
3. Walk steps: Welcome → Choose source (file/dir dump) → Mode (corpus recommended) → SoftWrite confirm → Import with **pipeline progress** (scan/parse/template/redact/store/embed) → Ready.
4. Finish → chat has **log-triage** skill pinned and a starter RCA prompt in the composer.
5. Optional: open **Logs** pane to see corpus clusters; ingest there also shows process progress (not only “Working…”).

## Fixture

Any small log file/dir with repeated error lines works. Synthetic multi-k line fixture used in tests: `log_analysis::ingest::tests::ingest_fixture_multi_format_with_reduction`.

## Cancel

Cancel on Welcome/Source leaves app usable; blank **New chat** never requires a wizard.
