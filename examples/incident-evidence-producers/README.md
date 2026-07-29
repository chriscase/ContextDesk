# Producer templates — Incident Evidence Bundle v1

These copy/paste sketches show how a support collector or exporter can build a
**directory-form** bundle that conforms to
`contextdesk.incident_evidence.v1`. They do **not** prescribe application
architecture.

## Happy path

1. Create a directory tree (`logs/`, optional `metrics/`, optional `attachments/`).
2. Write authorized log files with **relative** paths preserved.
3. Optionally write one operational-metrics **v1** JSON document (reuse the
   shipped series schema; do not invent another).
4. Hash each file (SHA-256, lowercase hex) and record exact byte lengths.
5. Write `manifest.json` with `schemaId`, producer, privacy, timeBasis, components.
6. Validate offline:

```bash
cargo run -p cd-core --bin cd-validate-incident-evidence -- validate ./my-bundle
cargo run -p cd-core --bin cd-validate-incident-evidence -- pack ./my-bundle --output ./my-bundle.zip
cargo run -p cd-core --bin cd-validate-incident-evidence -- validate ./my-bundle.zip
```

## Files

| File | Language |
| --- | --- |
| `produce.rs` | Rust |
| `produce.py` | Python 3 |
| `Produce.java` | Java 17+ |
| `produce.mjs` | JavaScript / TypeScript-friendly ESM |
| `produce.sh` | shell + `shasum` / `openssl` |

## Privacy

Never put credentials, private absolute paths, model inventories, or evaluator
truth into a shareable bundle. Set `privacy.containsCredentials` / `containsPii`
honestly; shareable fixtures use `false`.
