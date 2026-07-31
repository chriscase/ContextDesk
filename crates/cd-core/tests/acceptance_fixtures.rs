//! #819 — one manifest-driven generator for every packaged-acceptance fixture.
//!
//! These artifacts exist because the four states below **cannot be produced
//! through ordinary use**: local re-analysis does not reparse events, so
//! template identity never moves, and activation rejects a duplicate predicate
//! outright. A stale, conflicting, or unbound record is therefore something a
//! corpus or profile *arrives* carrying. No production UI, command, capability,
//! or release backdoor creates them.
//!
//! Regenerate with a single command:
//!
//! ```text
//! cargo test -p cd-core --test acceptance_fixtures -- --ignored --nocapture
//! ```
//!
//! Output goes to `$CD_ACCEPTANCE_FIXTURE_DIR` when set, otherwise
//! `target/acceptance-fixtures/` — both ignored by git. Nothing is committed as
//! a binary archive.

// Shared test-support modules: each including test binary uses a different
// subset, so unused items here are expected rather than dead code.
// `legacy_investigation_fixture` carries its own inner `allow(dead_code)`.
#[path = "support/legacy_investigation_fixture.rs"]
mod legacy_investigation_fixture;
#[allow(dead_code)]
#[path = "support/suppression_fixtures.rs"]
mod suppression_fixtures;

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Manifest schema for the acceptance fixture set.
const MANIFEST_SCHEMA_VERSION: u32 = 1;
/// Refuse to emit an artifact larger than this; fixtures must stay bounded.
const MAX_FIXTURE_BYTES: u64 = 4 * 1024 * 1024;

fn output_dir() -> PathBuf {
    match std::env::var_os("CD_ACCEPTANCE_FIXTURE_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/acceptance-fixtures")
            .to_path_buf(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// One manifest row. Deliberately payload-free: names, expectations, and
/// integrity only — never event text, template text, paths, or tokens.
fn entry(
    name: &str,
    file: &str,
    bytes: &[u8],
    expected_status: &str,
    expected_label: &str,
    expected_rule_count: usize,
    expected_exclusions: usize,
) -> serde_json::Value {
    serde_json::json!({
        "name": name,
        "file": file,
        "sha256": sha256_hex(bytes),
        "bytes": bytes.len(),
        "expectedStatus": expected_status,
        "expectedLabel": expected_label,
        "expectedRuleCount": expected_rule_count,
        "expectedExclusions": expected_exclusions,
    })
}

/// Generate every acceptance fixture plus a manifest describing it.
///
/// Ignored by default so ordinary `cargo test` never writes artifacts.
#[test]
#[ignore = "artifact generator; run explicitly with --ignored"]
fn generate_acceptance_fixtures() {
    let out = output_dir();
    std::fs::create_dir_all(&out).expect("create fixture output dir");
    let cache = tempfile::tempdir().expect("scratch cache");

    let mut entries = Vec::new();

    for (name, package, status, label, rules) in [
        (
            "fingerprint-changed",
            suppression_fixtures::fingerprint_changed_package(cache.path(), &out)
                .expect("fingerprint fixture"),
            "stale_fingerprint_changed",
            "Stale — template changed",
            1usize,
        ),
        (
            "target-missing",
            suppression_fixtures::target_missing_package(cache.path(), &out)
                .expect("target-missing fixture"),
            "stale_target_missing",
            "Stale — matches nothing",
            1,
        ),
        (
            "conflicting-predicates",
            suppression_fixtures::conflicting_predicates_package(cache.path(), &out)
                .expect("conflicting fixture"),
            "conflicting_predicate",
            "Conflicts with another rule",
            2,
        ),
    ] {
        let bytes = std::fs::read(&package.path).expect("read package");
        assert!(
            bytes.len() as u64 <= MAX_FIXTURE_BYTES,
            "{name} fixture exceeds the bound"
        );
        assert_eq!(package.rule_names.len(), rules, "{name} rule count");
        entries.push(entry(
            name,
            package
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .expect("file name"),
            &bytes,
            status,
            label,
            rules,
            0,
        ));
    }

    // The legacy fixture is a PAIR: a corpus package plus an investigation
    // directory. The investigation cites events in that corpus, so it is
    // unusable alone — a machine that has never imported the corpus cannot
    // resolve the evidence.
    let legacy_profile = out.join("legacy-unbound-profile");
    std::fs::create_dir_all(&legacy_profile).expect("legacy profile dir");
    let legacy_corpus =
        legacy_investigation_fixture::legacy_fixture_corpus(cache.path()).expect("legacy corpus");
    let origin_corpus_id = legacy_corpus.id().to_string();
    let corpus_package = legacy_investigation_fixture::export_legacy_fixture_corpus(
        legacy_corpus,
        cache.path(),
        out.join("fixture-legacy-corpus.zip"),
    )
    .expect("export paired legacy corpus");
    let corpus_bytes = std::fs::read(&corpus_package).expect("read legacy corpus package");
    assert!(
        corpus_bytes.len() as u64 <= MAX_FIXTURE_BYTES,
        "legacy corpus package exceeds the bound"
    );

    let legacy = legacy_investigation_fixture::install_legacy_unbound_investigation_for_corpus_id(
        legacy_profile
            .canonicalize()
            .expect("absolute legacy root")
            .as_path(),
        &origin_corpus_id,
    )
    .expect("install legacy fixture");
    let legacy_bytes = std::fs::read(&legacy.revision_path).expect("read legacy revision");
    assert!(
        legacy_bytes.len() as u64 <= MAX_FIXTURE_BYTES,
        "legacy fixture exceeds the bound"
    );
    entries.push(serde_json::json!({
        "name": "legacy-unbound-finding",
        "kind": "paired-corpus-and-investigation",
        "corpusPackageFile": "fixture-legacy-corpus.zip",
        "corpusPackageSha256": sha256_hex(&corpus_bytes),
        "corpusPackageBytes": corpus_bytes.len(),
        "investigationFile": format!(
            "legacy-unbound-profile/{}/{}",
            legacy.investigation_id,
            legacy_investigation_fixture::revision_filename(legacy.revision),
        ),
        "investigationSha256": sha256_hex(&legacy_bytes),
        "investigationBytes": legacy_bytes.len(),
        "investigationSchemaVersion": 3,
        "expectedStatus": "unbound_legacy",
        "expectedLabel": "Legacy finding · no noise-policy binding",
        "expectedFindingCount": 1,
        "expectedPolicyBinding": "none",
        "expectedExclusions": 0,
        "corpusRelationship": {
            "boundCorpusId": origin_corpus_id,
            "note": "The investigation cites events in the paired corpus and cannot resolve evidence without it.",
            "importRebindsIdentity": true,
            "rebindRequired": "import_corpus_zip always mints a new corpus id, so the investigation must be rebound to the id the local import assigned before its evidence resolves.",
        },
        "setupOrder": [
            "1. Import fixture-legacy-corpus.zip through the ordinary Logs import.",
            "2. Note the corpus id the import assigned.",
            "3. Quit the app.",
            "4. Install the investigation directory rebound to that id (see README).",
            "5. Reopen the app and the paired corpus.",
        ],
        "cleanupIdentities": {
            "investigationDirectory": legacy.investigation_id,
            "corpusDisplayName": format!("{} legacy investigation", legacy_investigation_fixture::FIXTURE_LABEL),
            "note": "Remove only this investigation directory and discard only this corpus.",
        },
    }));

    write_native_readme(&out, &legacy, &origin_corpus_id);

    let manifest = serde_json::json!({
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "purpose": "ContextDesk #819 packaged-acceptance fixtures",
        "note": "Ordinary UI cannot create these historical states; they arrive with imported evidence.",
        "identity": "TEST-FIXTURE",
        "fixtures": entries,
        "cleanup": "Delete the output directory; fixtures are disposable and hold no user data.",
        "regenerate": "cargo test -p cd-core --test acceptance_fixtures -- --ignored --nocapture",
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).expect("serialize manifest");
    let manifest_path = out.join("acceptance-manifest.json");
    std::fs::write(&manifest_path, &manifest_bytes).expect("write manifest");

    println!("acceptance fixtures written to {}", out.display());
    println!("manifest sha256 {}", sha256_hex(&manifest_bytes));
}

/// The manifest is evidence, not a data leak: it may carry names, expected
/// statuses, counts, and digests, and must never carry payloads, template text,
/// representatives, absolute paths, tokens, or secrets.
#[test]
fn acceptance_manifest_is_payload_free() {
    let out = tempfile::tempdir().expect("out");
    let cache = tempfile::tempdir().expect("cache");

    // Build every fixture the generator emits, then scan the real manifest.
    let mut entries = Vec::new();
    for (name, package, status, label, rules) in [
        (
            "fingerprint-changed",
            suppression_fixtures::fingerprint_changed_package(cache.path(), out.path())
                .expect("fingerprint fixture"),
            "stale_fingerprint_changed",
            "Stale — template changed",
            1usize,
        ),
        (
            "target-missing",
            suppression_fixtures::target_missing_package(cache.path(), out.path())
                .expect("target-missing fixture"),
            "stale_target_missing",
            "Stale — matches nothing",
            1,
        ),
        (
            "conflicting-predicates",
            suppression_fixtures::conflicting_predicates_package(cache.path(), out.path())
                .expect("conflicting fixture"),
            "conflicting_predicate",
            "Conflicts with another rule",
            2,
        ),
    ] {
        let bytes = std::fs::read(&package.path).expect("read package");
        entries.push(entry(
            name,
            package
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .expect("file name"),
            &bytes,
            status,
            label,
            rules,
            0,
        ));
    }

    let legacy_corpus =
        legacy_investigation_fixture::legacy_fixture_corpus(cache.path()).expect("legacy corpus");
    let legacy = legacy_investigation_fixture::install_legacy_unbound_investigation(
        out.path().canonicalize().expect("absolute").as_path(),
        &legacy_corpus,
    )
    .expect("legacy fixture");
    let legacy_bytes = std::fs::read(&legacy.revision_path).expect("read legacy");
    entries.push(entry(
        "legacy-unbound-finding",
        &legacy_investigation_fixture::revision_filename(legacy.revision),
        &legacy_bytes,
        "unbound_legacy",
        "Legacy finding · no noise-policy binding",
        1,
        0,
    ));

    let manifest = serde_json::json!({
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "identity": "TEST-FIXTURE",
        "fixtures": entries,
    });
    let text = serde_json::to_string(&manifest).expect("serialize");

    for forbidden in [
        "routine health",            // template text
        "different evidence",        // template text
        "routine health ok",         // event payload
        "fixture/app.log",           // source path
        "sha256:fixture-routine",    // template fingerprint
        "sha256:fixture-different",  // template fingerprint
        "sha256:fixture-conflicted", // template fingerprint
        "previewToken",
        "preview_token",
        "representative",
        "/Users/",
        "\\Users\\",
        "/var/folders/", // absolute temp path
    ] {
        assert!(
            !text.contains(forbidden),
            "acceptance manifest leaked {forbidden}"
        );
    }
    // Digests are hex sha256 of the artifact, not of any payload field.
    assert_eq!(entries_len(&manifest), 4, "all four fixtures described");
    assert!(text.contains("\"sha256\""));
    assert!(text.contains("TEST-FIXTURE"));
}

fn entries_len(manifest: &serde_json::Value) -> usize {
    manifest["fixtures"].as_array().map_or(0, Vec::len)
}

/// Write the safe, reversible native-acceptance procedure beside the artifacts.
///
/// Deliberately free of absolute paths: it names artifacts relative to this
/// directory and identities by id, so it can be read and followed without
/// revealing anything about the machine that generated it.
fn write_native_readme(
    out: &Path,
    legacy: &legacy_investigation_fixture::LegacyInvestigationFixture,
    origin_corpus_id: &str,
) {
    let revision = legacy_investigation_fixture::revision_filename(legacy.revision);
    let body = format!(
        r#"# ContextDesk #819 — native acceptance fixtures

`TEST-FIXTURE` artifacts for the four #819 states that ordinary use cannot
create. Local re-analysis does not reparse events, so template identity never
moves; activation refuses a duplicate predicate; and every shipped mutation
stamps a policy binding, so an unbound finding can only come from an older
build.

Everything here is disposable and holds no user data.

## Three ordinary import packages

Import each through the normal Logs import. No extra steps.

- `fixture-fingerprint-changed.zip` — rule shows **Stale — template changed**
- `fixture-target-missing.zip` — rule shows **Stale — matches nothing**
- `fixture-conflicting-predicates.zip` — both rules show **Conflicts with another rule**

In every case the rules stay visible with their rationale and audit, and hide
zero events.

## The legacy pair (corpus + investigation)

`fixture-legacy-corpus.zip` and `legacy-unbound-profile/` are **one fixture**.
The investigation cites events inside that corpus, so installing it alone
proves nothing — the evidence cannot resolve.

Production `import_corpus_zip` always assigns a **new** corpus id and records
the packaged one as `origin_corpus_id`. The shipped investigation is bound to
`{origin_corpus_id}`, which your import will not reproduce, so it must be
rebound to the id your machine assigns.

### Procedure (safe and reversible)

1. **Import** `fixture-legacy-corpus.zip` through the ordinary Logs import.
   The corpus appears as `TEST-FIXTURE legacy investigation`.
2. **Note the corpus id** the import assigned (Logs library detail panel).
3. **Quit the app completely.** Do not install while it is running.
4. **Install the investigation.** Regenerate it bound to your local id, into a
   directory you control, then copy that single directory into the app's
   investigations root:

   ```
   CD_FIXTURE_CORPUS_ID=<id from step 2> \
   CD_FIXTURE_PROFILE_ROOT=<an empty directory you control> \
   cargo test -p cd-core --test acceptance_fixtures \
     rebind_legacy_investigation_for_native_use -- --ignored --nocapture
   ```

   Copy **only** the single `TEST-FIXTURE` investigation directory it prints.
   **Refuse to overwrite:** if a directory with that exact UUID already exists
   in the investigations root, stop and investigate — do not replace it. The
   installer itself creates the revision file with `create_new`, so it will
   never clobber an existing record.
5. **Reopen** the app and the paired corpus. The finding shows
   **Legacy finding · no noise-policy binding**, Apply is blocked, and its
   cited evidence resolves.
6. **Relaunch** the app and confirm the finding and its label persist.

### Cleanup

- Remove **only** the investigation directory whose name is the UUID printed in
  step 4 (the shipped one is `{investigation_id}`; a rebound copy prints its
  own).
- Discard **only** the corpus named `TEST-FIXTURE legacy investigation`.
- Delete this fixture directory.

Nothing else in the profile is touched at any point. No production command,
capability, or backdoor is involved: the app never installs a fixture, and the
copy in step 4 is a deliberate manual act performed while the app is closed.

## Artifacts

| file | role |
| ---- | ---- |
| `acceptance-manifest.json` | digests, sizes, expected statuses/labels, setup order, cleanup identities |
| `fixture-fingerprint-changed.zip` | ordinary import |
| `fixture-target-missing.zip` | ordinary import |
| `fixture-conflicting-predicates.zip` | ordinary import |
| `fixture-legacy-corpus.zip` | paired corpus — import first |
| `legacy-unbound-profile/{investigation_id}/{revision}` | paired investigation — rebind, then install |

Regenerate everything:

```
cargo test -p cd-core --test acceptance_fixtures -- --ignored --nocapture
```
"#,
        origin_corpus_id = origin_corpus_id,
        investigation_id = legacy.investigation_id,
        revision = revision,
    );
    std::fs::write(out.join("README.md"), body).expect("write native acceptance README");
}

/// Emit a legacy investigation bound to a **locally imported** corpus id.
///
/// Native use only: production import re-mints corpus ids, so the shipped
/// investigation cannot match a tester's import. This writes one investigation
/// directory into an explicitly supplied root and prints its identity. It
/// touches no real profile — the caller chooses the destination and performs
/// the copy manually while the app is closed.
#[test]
#[ignore = "native acceptance helper; run explicitly with --ignored"]
fn rebind_legacy_investigation_for_native_use() {
    let corpus_id = std::env::var("CD_FIXTURE_CORPUS_ID")
        .expect("set CD_FIXTURE_CORPUS_ID to the id your local import assigned");
    let root = std::env::var("CD_FIXTURE_PROFILE_ROOT")
        .expect("set CD_FIXTURE_PROFILE_ROOT to an empty directory you control");
    let root = PathBuf::from(root);
    std::fs::create_dir_all(&root).expect("create supplied root");
    let root = root.canonicalize().expect("absolute supplied root");

    let fixture = legacy_investigation_fixture::install_legacy_unbound_investigation_for_corpus_id(
        &root, &corpus_id,
    )
    .expect("install rebound legacy investigation");

    println!("bound to corpus id      {corpus_id}");
    println!("investigation directory {}", fixture.investigation_id);
    println!(
        "revision file           {}",
        fixture.revision_path.display()
    );
    println!("copy ONLY that single directory into the app's investigations root");
}
