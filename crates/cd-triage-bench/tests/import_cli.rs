//! CLI acceptance for #878: manual import and provenance (offline only).

mod common;

use assert_cmd::Command;
use common::*;
use predicates::prelude::*;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn bench() -> Command {
    Command::cargo_bin("cd-triage-bench").expect("cd-triage-bench")
}

fn write_json(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

struct Seeded {
    tmp: tempfile::TempDir,
    library: PathBuf,
    home_file: PathBuf,
    task_id: String,
}

impl Seeded {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let library = tmp.path().join("lib");
        let home_file = tmp.path().join("home-is-a-file");
        fs::write(&home_file, b"must remain unchanged").unwrap();

        bench()
            .env("HOME", &home_file)
            .args(["--library", library.to_str().unwrap(), "init"])
            .assert()
            .success();

        let case_path = tmp.path().join("case.json");
        write_json(
            &case_path,
            &json!({
                "schema_id": "contextdesk.triage_bench.case.v1",
                "case_id": "case-cli-878",
                "privacy": "share_safe",
                "title": "CLI import case",
                "reported_problem": { "summary": "checkout 500s" },
                "lifecycle": "unresolved",
                "timeline_notes": [],
                "created_at": "2026-01-15T00:00:00Z"
            }),
        );
        bench()
            .env("HOME", &home_file)
            .args([
                "--library",
                library.to_str().unwrap(),
                "import-case",
                case_path.to_str().unwrap(),
            ])
            .assert()
            .success();

        let blob = tmp.path().join("app.log");
        fs::write(&blob, LOG_BYTES).unwrap();
        let digest = cd_triage_bench::types::ContentDigest::of_bytes(LOG_BYTES);
        let snapshot_path = tmp.path().join("snapshot.json");
        write_json(
            &snapshot_path,
            &json!({
                "schema_id": "contextdesk.triage_bench.evidence_snapshot.v1",
                "privacy": "share_safe",
                "case_id": "case-cli-878",
                "captured_at": "2026-01-15T06:00:00Z",
                "captured_by": "cli",
                "items": [{
                    "kind": "log",
                    "item_id": "ev-log-1",
                    "privacy": "share_safe",
                    "capture_time": "2026-01-15T04:12:00Z",
                    "source": { "reference": "app.log", "captured_from": "cli" },
                    "media_type": "text/plain",
                    "format": "raw",
                    "content": {
                        "digest": { "algorithm": "sha256", "hex": digest.hex },
                        "byte_length": LOG_BYTES.len()
                    },
                    "summaries": [],
                    "visible_to_strategies": true
                }]
            }),
        );
        let snap_out = bench()
            .env("HOME", &home_file)
            .args([
                "--library",
                library.to_str().unwrap(),
                "import-snapshot",
                snapshot_path.to_str().unwrap(),
                "--blob",
                blob.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            snap_out.status.success(),
            "{}",
            String::from_utf8_lossy(&snap_out.stderr)
        );

        let snapshot_id = String::from_utf8(snap_out.stdout)
            .unwrap()
            .trim()
            .to_string();
        let task_path = tmp.path().join("task.json");
        write_json(
            &task_path,
            &json!({
                "schema_id": "contextdesk.triage_bench.evaluation_task.v1",
                "privacy": "share_safe",
                "case_id": "case-cli-878",
                "snapshot_id": snapshot_id,
                "question": "What failed?",
                "protocol": "visible evidence only",
                "protocol_version": "v1",
                "visibility": {
                    "visible_item_ids": ["ev-log-1"],
                    "include_summaries": true,
                    "include_raw_bytes": true
                },
                "created_at": "2026-01-15T07:00:00Z"
            }),
        );
        let task_out = bench()
            .env("HOME", &home_file)
            .args([
                "--library",
                library.to_str().unwrap(),
                "import-task",
                task_path.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            task_out.status.success(),
            "{}",
            String::from_utf8_lossy(&task_out.stderr)
        );
        let task_id = String::from_utf8(task_out.stdout)
            .unwrap()
            .trim()
            .to_string();
        Self {
            tmp,
            library,
            home_file,
            task_id,
        }
    }

    fn import_run(&self, file: &Path, raw: Option<&Path>) -> String {
        let mut cmd = bench();
        cmd.env("HOME", &self.home_file).args([
            "--library",
            self.library.to_str().unwrap(),
            "import-run",
            file.to_str().unwrap(),
        ]);
        if let Some(raw) = raw {
            cmd.args(["--raw", raw.to_str().unwrap()]);
        }
        let out = cmd.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    }

    fn show_run(&self, run_id: &str) -> Value {
        let out = bench()
            .env("HOME", &self.home_file)
            .args([
                "--library",
                self.library.to_str().unwrap(),
                "show",
                "runs",
                run_id,
            ])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }
}

fn created_run_id(stdout: &str) -> String {
    let line = stdout.trim();
    let id = line
        .strip_prefix("created ")
        .unwrap_or(line)
        .split_whitespace()
        .next()
        .expect("run id");
    assert!(id.starts_with("run-"), "{stdout}");
    id.to_string()
}

fn blob_path(library: &Path, hex: &str) -> PathBuf {
    library.join("blobs/sha256").join(&hex[..2]).join(hex)
}

#[test]
fn issue_878_cli_imports_three_source_kinds_with_provenance() {
    let seed = Seeded::new();
    let example = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/templates/human-run.example.md"),
    )
    .unwrap();
    let human_md = example.replace("REPLACE_WITH_TASK_ID", &seed.task_id);
    let human_path = seed.tmp.path().join("human.md");
    fs::write(&human_path, &human_md).unwrap();
    let human_body = human_md
        .rsplit_once("```\n")
        .map(|(_, body)| body.to_string())
        .expect("example body after fence");

    let human_out = seed.import_run(&human_path, None);
    let human_id = created_run_id(&human_out);
    let human = seed.show_run(&human_id);
    assert_eq!(human["source_kind"], "human");
    assert_eq!(human["operator"], "alex-oncall");
    assert_eq!(human["importer"], "bench-operator");
    assert_eq!(human["prompt_workflow"]["completeness"], "unknown");
    assert_eq!(human["prompt_workflow"]["prompt"]["status"], "unknown");
    assert_eq!(human["timing"]["status"], "unknown");
    assert_eq!(human["cost"]["status"], "unknown");
    assert_eq!(human["fairness"]["kind"], "same_snapshot");
    assert_eq!(human["strategy"]["version"]["status"], "unknown");
    let human_hex = human["raw_output"]["digest"]["hex"].as_str().unwrap();
    assert_eq!(
        human_hex,
        cd_triage_bench::types::sha256_hex(human_body.as_bytes())
    );
    let stored = fs::read(blob_path(&seed.library, human_hex)).unwrap();
    assert_eq!(stored, human_body.as_bytes());
    assert_eq!(cd_triage_bench::types::sha256_hex(&stored), human_hex);

    let web_raw = "Pasted assistant transcript: looks like DNS.\n";
    let web_path = seed.tmp.path().join("web.json");
    write_json(
        &web_path,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": seed.task_id,
            "strategy": {
                "name": "web-assistant",
                "version": { "status": "known", "value": "paste" },
                "build": { "status": "unknown" }
            },
            "source_kind": "web_only",
            "prompt_workflow": {
                "completeness": "exact",
                "prompt": { "status": "known", "value": "What failed in this log?" },
                "workflow": { "status": "known", "value": "copied from a browser session" }
            },
            "raw_output_utf8": web_raw,
            "claims": [{
                "claim": "DNS",
                "evidence_item_id": "ev-does-not-exist"
            }],
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "fairness": { "kind": "unknown_visibility" },
            "status": "completed",
            "operator": "alice",
            "privacy": "share_safe",
            "created_at": "2026-01-15T08:05:00Z"
        }),
    );
    let web_id = created_run_id(&seed.import_run(&web_path, None));
    let web = seed.show_run(&web_id);
    assert_eq!(web["source_kind"], "web_only");
    assert_eq!(web["prompt_workflow"]["completeness"], "exact");
    assert_eq!(web["fairness"]["kind"], "unknown_visibility");
    assert_eq!(web["claims"][0]["evidence_item_id"], "ev-does-not-exist");
    assert_eq!(
        web["raw_output"]["digest"]["hex"],
        cd_triage_bench::types::sha256_hex(web_raw.as_bytes())
    );

    let other_raw = b"JSON export from another product: timeout likely.\n";
    let other_raw_path = seed.tmp.path().join("other.txt");
    fs::write(&other_raw_path, other_raw).unwrap();
    let other_path = seed.tmp.path().join("other.json");
    write_json(
        &other_path,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": seed.task_id,
            "strategy": {
                "name": "other-product",
                "version": { "status": "known", "value": "9.1" },
                "build": { "status": "unknown" }
            },
            "source_kind": "other_product",
            "prompt_workflow": {
                "completeness": "partial",
                "prompt": { "status": "unknown" },
                "workflow": { "status": "known", "value": "exported after a UI session" }
            },
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "known", "value": "inconclusive" },
            "fairness": {
                "kind": "extra_evidence",
                "description": "operator also opened a later log not in the snapshot"
            },
            "status": "partial",
            "operator": "carol",
            "privacy": "share_safe",
            "created_at": "2026-01-15T08:10:00Z"
        }),
    );
    let other_id = created_run_id(&seed.import_run(&other_path, Some(&other_raw_path)));
    let other = seed.show_run(&other_id);
    assert_eq!(other["source_kind"], "other_product");
    assert_eq!(other["prompt_workflow"]["completeness"], "partial");
    assert_eq!(other["fairness"]["kind"], "extra_evidence");
    assert_eq!(
        other["raw_output"]["digest"]["hex"],
        cd_triage_bench::types::sha256_hex(other_raw)
    );
    assert_eq!(
        fs::read(blob_path(
            &seed.library,
            other["raw_output"]["digest"]["hex"].as_str().unwrap()
        ))
        .unwrap(),
        other_raw
    );

    let listed = bench()
        .env("HOME", &seed.home_file)
        .args(["--library", seed.library.to_str().unwrap(), "list", "runs"])
        .output()
        .unwrap();
    let listed = String::from_utf8(listed.stdout).unwrap();
    assert!(listed.contains(&human_id));
    assert!(listed.contains(&web_id));
    assert!(listed.contains(&other_id));
    assert_eq!(listed.lines().filter(|l| l.starts_with("run-")).count(), 3);

    let dup = seed.import_run(&web_path, None);
    assert!(dup.starts_with(&format!("duplicate {web_id}")), "{dup}");

    let near_path = seed.tmp.path().join("web-near.json");
    write_json(
        &near_path,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": seed.task_id,
            "strategy": {
                "name": "web-assistant",
                "version": { "status": "known", "value": "paste" },
                "build": { "status": "unknown" }
            },
            "source_kind": "web_only",
            "prompt_workflow": {
                "completeness": "exact",
                "prompt": { "status": "known", "value": "What failed in this log?" },
                "workflow": { "status": "known", "value": "copied from a browser session" }
            },
            "raw_output_utf8": format!("{web_raw} "),
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "fairness": { "kind": "unknown_visibility" },
            "status": "completed",
            "operator": "alice",
            "privacy": "share_safe",
            "created_at": "2026-01-15T08:06:00Z"
        }),
    );
    let near_out = seed.import_run(&near_path, None);
    assert!(near_out.starts_with("created run-"), "{near_out}");
    let near_id = created_run_id(&near_out);
    assert_ne!(near_id, web_id);

    let same_raw_new_fairness = seed.tmp.path().join("web-extra.json");
    write_json(
        &same_raw_new_fairness,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": seed.task_id,
            "strategy": {
                "name": "web-assistant",
                "version": { "status": "known", "value": "paste" },
                "build": { "status": "unknown" }
            },
            "source_kind": "web_only",
            "prompt_workflow": {
                "completeness": "exact",
                "prompt": { "status": "known", "value": "What failed in this log?" },
                "workflow": { "status": "known", "value": "copied from a browser session" }
            },
            "raw_output_utf8": web_raw,
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "fairness": {
                "kind": "extra_evidence",
                "description": "also pasted a later screenshot"
            },
            "status": "completed",
            "operator": "alice",
            "privacy": "share_safe",
            "created_at": "2026-01-15T08:07:00Z"
        }),
    );
    let extra_out = seed.import_run(&same_raw_new_fairness, None);
    assert!(extra_out.contains("near_duplicate_of="), "{extra_out}");
    let extra_id = created_run_id(&extra_out);
    assert_ne!(extra_id, web_id);
    assert_eq!(
        seed.show_run(&web_id)["fairness"]["kind"],
        "unknown_visibility"
    );

    let first_fairness = human["fairness"].clone();
    let mut mutated = human.clone();
    mutated["fairness"] = json!({"kind": "unknown_visibility"});
    let run_file = seed.library.join("runs").join(format!("{human_id}.json"));
    write_json(&run_file, &mutated);
    bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "show",
            "runs",
            &human_id,
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("fingerprint").or(predicate::str::contains("immutable")));
    write_json(&run_file, &human);
    let restored = seed.show_run(&human_id);
    assert_eq!(restored["fairness"], first_fairness);

    assert_eq!(fs::read(&seed.home_file).unwrap(), b"must remain unchanged");
}

#[test]
fn issue_878_cli_requires_fairness_and_rejects_omitted_version() {
    let seed = Seeded::new();
    let missing_fairness = seed.tmp.path().join("no-fairness.json");
    write_json(
        &missing_fairness,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": seed.task_id,
            "strategy": {
                "name": "human-expert",
                "version": { "status": "unknown" },
                "build": { "status": "unknown" }
            },
            "source_kind": "human",
            "prompt_workflow": {
                "completeness": "unknown",
                "prompt": { "status": "unknown" },
                "workflow": { "status": "unknown" }
            },
            "raw_output_utf8": "write-up",
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "status": "completed",
            "operator": "alice",
            "created_at": "2026-01-15T08:00:00Z"
        }),
    );
    bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-run",
            missing_fairness.to_str().unwrap(),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("fairness"));

    let missing_version = seed.tmp.path().join("no-version.json");
    write_json(
        &missing_version,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": seed.task_id,
            "strategy": {
                "name": "human-expert",
                "build": { "status": "unknown" }
            },
            "source_kind": "human",
            "prompt_workflow": {
                "completeness": "unknown",
                "prompt": { "status": "unknown" },
                "workflow": { "status": "unknown" }
            },
            "raw_output_utf8": "write-up",
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "fairness": { "kind": "same_snapshot" },
            "status": "completed",
            "operator": "alice",
            "created_at": "2026-01-15T08:00:00Z"
        }),
    );
    bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-run",
            missing_version.to_str().unwrap(),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("version"));
}
