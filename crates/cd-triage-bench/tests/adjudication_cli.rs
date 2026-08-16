//! CLI acceptance for #880: rubric v1 and expert adjudication (offline only).

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
    case_id: String,
    snapshot_id: String,
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

        let case_id = "case-cli-880";
        let case_path = tmp.path().join("case.json");
        write_json(
            &case_path,
            &json!({
                "schema_id": "contextdesk.triage_bench.case.v1",
                "case_id": case_id,
                "privacy": "share_safe",
                "title": "CLI adjudication case",
                "reported_problem": { "summary": "checkout 500s" },
                "lifecycle": "resolved",
                "timeline_notes": [],
                "created_at": "2026-01-15T00:00:00Z",
                "resolution": {
                    "adjudicated_root_cause": "inventory client timeout",
                    "fix": "raise client timeout",
                    "notes": "evaluation-only"
                }
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
                "case_id": case_id,
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
                "case_id": case_id,
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
            case_id: case_id.into(),
            snapshot_id,
            task_id,
        }
    }

    fn import_run_json(&self, name: &str, source_kind: &str, raw: &str, extra: Value) -> String {
        let mut body = json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": self.task_id,
            "strategy": {
                "name": name,
                "version": { "status": "unknown" },
                "build": { "status": "unknown" }
            },
            "source_kind": source_kind,
            "prompt_workflow": {
                "completeness": "unknown",
                "prompt": { "status": "unknown" },
                "workflow": { "status": "unknown" }
            },
            "raw_output_utf8": raw,
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "fairness": { "kind": "same_snapshot" },
            "status": "completed",
            "operator": "alice",
            "privacy": "share_safe",
            "created_at": "2026-01-15T08:00:00Z"
        });
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                body[k] = v.clone();
            }
        }
        let path = self.tmp.path().join(format!("{name}.json"));
        write_json(&path, &body);
        let out = bench()
            .env("HOME", &self.home_file)
            .args([
                "--library",
                self.library.to_str().unwrap(),
                "import-run",
                path.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let stdout = String::from_utf8(out.stdout).unwrap();
        stdout
            .trim()
            .strip_prefix("created ")
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .to_string()
    }

    fn review_packet(&self, run_id: &str, phase: &str) -> (bool, String) {
        let out = bench()
            .env("HOME", &self.home_file)
            .args([
                "--library",
                self.library.to_str().unwrap(),
                "review-packet",
                run_id,
                "--phase",
                phase,
            ])
            .output()
            .unwrap();
        (
            out.status.success(),
            if out.status.success() {
                String::from_utf8(out.stdout).unwrap()
            } else {
                String::from_utf8_lossy(&out.stderr).into_owned()
            },
        )
    }

    fn import_adj(&self, value: &Value) -> (String, String) {
        let mut value = value.clone();
        if value.get("review_packet_id").is_none() {
            let run_id = value["run_id"].as_str().unwrap();
            let phase = value["phase"].as_str().unwrap();
            let (ok, packet) = self.review_packet(run_id, phase);
            if ok {
                let packet: Value = serde_json::from_str(&packet).unwrap();
                value["review_packet_id"] = packet["packet_id"].clone();
            }
        }
        let path = self.tmp.path().join(format!(
            "adj-{}.json",
            value["reviewer"].as_str().unwrap_or("r")
        ));
        write_json(&path, &value);
        let out = bench()
            .env("HOME", &self.home_file)
            .args([
                "--library",
                self.library.to_str().unwrap(),
                "import-adjudication",
                path.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let line = String::from_utf8(out.stdout).unwrap();
        let mut parts = line.split_whitespace();
        (
            parts.next().unwrap().to_string(),
            parts.next().unwrap().to_string(),
        )
    }

    fn show(&self, kind: &str, id: &str) -> Value {
        let out = bench()
            .env("HOME", &self.home_file)
            .args([
                "--library",
                self.library.to_str().unwrap(),
                "show",
                kind,
                id,
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

fn outcomes(
    diagnosis: Value,
    evidence: Value,
    action: Value,
    uncertainty: Value,
    unsafe_claims: Value,
) -> Value {
    json!([
        {
            "dimension": "diagnosis_correctness",
            "verdict": diagnosis,
            "rationale": "diagnosis rationale",
            "assist_flags": []
        },
        {
            "dimension": "evidence_support",
            "verdict": evidence,
            "rationale": "evidence rationale",
            "assist_flags": []
        },
        {
            "dimension": "actionability",
            "verdict": action,
            "rationale": "action rationale",
            "assist_flags": []
        },
        {
            "dimension": "uncertainty_calibration",
            "verdict": uncertainty,
            "rationale": "uncertainty rationale",
            "assist_flags": []
        },
        {
            "dimension": "unsafe_unsupported_claims",
            "verdict": unsafe_claims,
            "rationale": "unsafe rationale",
            "assist_flags": []
        }
    ])
}

#[test]
fn issue_880_cli_rubric_and_adjudication_acceptance() {
    let seed = Seeded::new();
    let human_id = seed.import_run_json(
        "human-expert",
        "human",
        HUMAN_RAW,
        json!({"created_at": "2026-01-15T08:00:00Z"}),
    );

    let (ok, support) = seed.review_packet(&human_id, "support");
    assert!(ok, "{support}");
    let support_json: Value = serde_json::from_str(&support).unwrap();
    assert_eq!(support_json["phase"], "support");
    assert_eq!(support_json["run"]["strategy_masked"], true);
    assert!(support_json["run"]["unblindable_reason"].is_null());
    assert!(support_json["resolution"].is_null());
    assert!(!support.contains("human-expert"));
    assert!(!support.contains("source_kind"));
    assert!(!support.contains("adjudicated_root_cause"));
    assert!(!support.contains("web_only"));
    assert!(support_json["run"]["raw_output_digest"]
        .as_str()
        .unwrap()
        .starts_with("sha256:"));

    let (diag_early_ok, diag_early) = seed.review_packet(&human_id, "diagnosis");
    assert!(!diag_early_ok, "{diag_early}");
    assert!(diag_early.contains("evidence-support"), "{diag_early}");

    let diagnosis_without_support = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": human_id,
        "reviewer": "reviewer-a",
        "conflict_of_interest": { "declared": false },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "diagnosis",
        "blinding": { "kind": "blinded" },
        "outcomes": outcomes(
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 3}),
        ),
        "created_at": "2026-01-15T09:50:00Z"
    });
    let diag_file = seed.tmp.path().join("diag-without-support.json");
    write_json(&diag_file, &diagnosis_without_support);
    bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-adjudication",
            diag_file.to_str().unwrap(),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("support-phase"));

    let blind_diagnosis = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": human_id,
        "reviewer": "reviewer-a",
        "conflict_of_interest": { "declared": false },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "support",
        "blinding": { "kind": "blinded" },
        "outcomes": outcomes(
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 3}),
        ),
        "created_at": "2026-01-15T09:51:00Z"
    });
    let blind_file = seed.tmp.path().join("blind-diagnosis.json");
    write_json(&blind_file, &blind_diagnosis);
    bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-adjudication",
            blind_file.to_str().unwrap(),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("diagnosis_correctness"));

    let leaky_raw = "web-assistant says the database is down. Citation: ev-does-not-exist\n";
    let web_id = seed.import_run_json(
        "web-assistant",
        "web_only",
        leaky_raw,
        json!({
            "created_at": "2026-01-15T08:05:00Z",
            "claims": [{
                "claim": "database is down",
                "evidence_item_id": "ev-does-not-exist"
            }]
        }),
    );
    let (ok, unblindable) = seed.review_packet(&web_id, "support");
    assert!(ok, "{unblindable}");
    let unblindable_json: Value = serde_json::from_str(&unblindable).unwrap();
    assert_eq!(unblindable_json["run"]["strategy_masked"], false);
    assert!(unblindable_json["run"]["unblindable_reason"]
        .as_str()
        .unwrap()
        .contains("strategy name"));
    assert_eq!(unblindable_json["blinding"]["kind"], "unblinded");
    assert!(!unblindable.contains("\"source_kind\""));
    assert!(!unblindable.contains("\"strategy\""));

    let support_a = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": human_id,
        "reviewer": "reviewer-a",
        "conflict_of_interest": { "declared": false },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "support",
        "blinding": { "kind": "blinded" },
        "outcomes": outcomes(
            json!({"kind": "not_applicable"}),
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 3}),
        ),
        "created_at": "2026-01-15T10:00:00Z"
    });
    seed.import_adj(&support_a);
    let adj_a = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": human_id,
        "reviewer": "reviewer-a",
        "conflict_of_interest": { "declared": false },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "diagnosis",
        "blinding": { "kind": "blinded" },
        "outcomes": outcomes(
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 3}),
        ),
        "created_at": "2026-01-15T10:01:00Z"
    });
    let (adj_a_id, score_a_id) = seed.import_adj(&adj_a);
    let shown_a = seed.show("adjudications", &adj_a_id);
    assert_eq!(shown_a["phase"], "diagnosis");
    assert_eq!(shown_a["reviewer"], "reviewer-a");
    assert_eq!(shown_a["conflict_of_interest"]["declared"], false);
    assert_eq!(
        shown_a["rubric_version"],
        "contextdesk.triage_bench.rubric.v1"
    );
    assert_eq!(shown_a["outcomes"][0]["rationale"], "diagnosis rationale");
    let score_a = seed.show("scores", &score_a_id);
    assert_eq!(
        score_a["rubric_version"],
        "contextdesk.triage_bench.rubric.v1"
    );
    assert_eq!(score_a["run_id"], human_id);

    let support_b = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": human_id,
        "reviewer": "reviewer-b",
        "conflict_of_interest": {
            "declared": true,
            "notes": "authored the human write-up"
        },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "support",
        "blinding": {
            "kind": "blinded"
        },
        "outcomes": outcomes(
            json!({"kind": "not_applicable"}),
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 1}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 3}),
        ),
        "created_at": "2026-01-15T10:05:00Z"
    });
    seed.import_adj(&support_b);
    let adj_b = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": human_id,
        "reviewer": "reviewer-b",
        "conflict_of_interest": {
            "declared": true,
            "notes": "authored the human write-up"
        },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "diagnosis",
        "blinding": {
            "kind": "blinded"
        },
        "outcomes": outcomes(
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 1}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 3}),
        ),
        "created_at": "2026-01-15T10:06:00Z"
    });
    let (adj_b_id, score_b_id) = seed.import_adj(&adj_b);
    assert_ne!(adj_a_id, adj_b_id);
    assert_ne!(score_a_id, score_b_id);
    let shown_b = seed.show("adjudications", &adj_b_id);
    assert_eq!(shown_b["conflict_of_interest"]["declared"], true);
    assert_eq!(
        shown_b["conflict_of_interest"]["notes"],
        "authored the human write-up"
    );
    assert_eq!(shown_b["outcomes"][0]["verdict"]["value"], 2);
    assert_eq!(shown_a["outcomes"][0]["verdict"]["value"], 3);
    assert_eq!(shown_b["outcomes"][0]["rationale"], "diagnosis rationale");
    let listed = bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "list",
            "adjudications",
        ])
        .output()
        .unwrap();
    let listed = String::from_utf8(listed.stdout).unwrap();
    assert!(listed.contains(&adj_a_id));
    assert!(listed.contains(&adj_b_id));

    let (ok, diagnosis) = seed.review_packet(&human_id, "diagnosis");
    assert!(ok, "{diagnosis}");
    assert!(diagnosis.contains("adjudicated_root_cause"));
    assert!(!diagnosis.contains("\"source_kind\""));

    let mut unsafe_outcomes = outcomes(
        json!({"kind": "score", "value": 0}),
        json!({"kind": "score", "value": 0}),
        json!({"kind": "score", "value": 1}),
        json!({"kind": "score", "value": 0}),
        json!({"kind": "score", "value": 0}),
    );
    unsafe_outcomes[4]["rationale"] = json!("invented citation and invented outage");
    let web_support = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": web_id,
        "reviewer": "reviewer-a",
        "conflict_of_interest": { "declared": false },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "support",
        "blinding": {
            "kind": "unblinded",
            "reason": "raw output contains the strategy name `web-assistant`"
        },
        "outcomes": outcomes(
            json!({"kind": "not_applicable"}),
            json!({"kind": "score", "value": 0}),
            json!({"kind": "score", "value": 1}),
            json!({"kind": "score", "value": 0}),
            json!({"kind": "score", "value": 0}),
        ),
        "created_at": "2026-01-15T10:09:00Z"
    });
    seed.import_adj(&web_support);
    let adj_web = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": web_id,
        "reviewer": "reviewer-a",
        "conflict_of_interest": { "declared": false },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "diagnosis",
        "blinding": {
            "kind": "unblinded",
            "reason": "raw output contains the strategy name `web-assistant`"
        },
        "outcomes": unsafe_outcomes,
        "created_at": "2026-01-15T10:10:00Z"
    });
    let (adj_web_id, _) = seed.import_adj(&adj_web);
    let shown_web = seed.show("adjudications", &adj_web_id);
    let unsafe_dim = shown_web["outcomes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["dimension"] == "unsafe_unsupported_claims")
        .unwrap();
    assert_eq!(unsafe_dim["verdict"]["value"], 0);
    assert!(unsafe_dim["assist_flags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|f| f
            .as_str()
            .unwrap()
            .contains("citation_not_in_snapshot:ev-does-not-exist")));

    let v1_score_path = seed
        .library
        .join("scores")
        .join(format!("{score_a_id}.json"));
    let v1_bytes = fs::read(&v1_score_path).unwrap();
    let adj_v2 = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": seed.case_id,
        "task_id": seed.task_id,
        "snapshot_id": seed.snapshot_id,
        "run_id": human_id,
        "reviewer": "reviewer-a",
        "conflict_of_interest": { "declared": false },
        "rubric_version": "contextdesk.triage_bench.rubric.v2",
        "phase": "diagnosis",
        "blinding": { "kind": "blinded" },
        "outcomes": outcomes(
            json!({"kind": "score", "value": 1}),
            json!({"kind": "score", "value": 1}),
            json!({"kind": "score", "value": 1}),
            json!({"kind": "score", "value": 1}),
            json!({"kind": "score", "value": 1}),
        ),
        "created_at": "2026-01-15T11:00:00Z"
    });
    let (adj_v2_id, score_v2_id) = seed.import_adj(&adj_v2);
    assert_ne!(adj_v2_id, adj_a_id);
    assert_ne!(score_v2_id, score_a_id);
    assert_eq!(fs::read(&v1_score_path).unwrap(), v1_bytes);
    let shown_v2 = seed.show("adjudications", &adj_v2_id);
    assert_eq!(
        shown_v2["rubric_version"],
        "contextdesk.triage_bench.rubric.v2"
    );
    let still_v1 = seed.show("scores", &score_a_id);
    assert_eq!(
        still_v1["rubric_version"],
        "contextdesk.triage_bench.rubric.v1"
    );
    assert_eq!(still_v1["dimensions"][0]["verdict"]["value"], 3);

    let unresolved_case = seed.tmp.path().join("unresolved.json");
    write_json(
        &unresolved_case,
        &json!({
            "schema_id": "contextdesk.triage_bench.case.v1",
            "case_id": "case-open-880",
            "privacy": "share_safe",
            "title": "No agreed cause",
            "reported_problem": { "summary": "intermittent 500s" },
            "lifecycle": "unresolved",
            "timeline_notes": [],
            "created_at": "2026-01-16T00:00:00Z"
        }),
    );
    bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-case",
            unresolved_case.to_str().unwrap(),
        ])
        .assert()
        .success();
    let unresolved_snap = seed.tmp.path().join("unresolved-snap.json");
    let digest = cd_triage_bench::types::ContentDigest::of_bytes(LOG_BYTES);
    write_json(
        &unresolved_snap,
        &json!({
            "schema_id": "contextdesk.triage_bench.evidence_snapshot.v1",
            "privacy": "share_safe",
            "case_id": "case-open-880",
            "captured_at": "2026-01-16T06:00:00Z",
            "captured_by": "cli",
            "items": [{
                "kind": "log",
                "item_id": "ev-log-u",
                "privacy": "share_safe",
                "capture_time": "2026-01-16T04:12:00Z",
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
    let blob = seed.tmp.path().join("app.log");
    fs::write(&blob, LOG_BYTES).unwrap();
    let snap_out = bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-snapshot",
            unresolved_snap.to_str().unwrap(),
            "--blob",
            blob.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let unresolved_snap_id = String::from_utf8(snap_out.stdout)
        .unwrap()
        .trim()
        .to_string();
    let unresolved_task = seed.tmp.path().join("unresolved-task.json");
    write_json(
        &unresolved_task,
        &json!({
            "schema_id": "contextdesk.triage_bench.evaluation_task.v1",
            "privacy": "share_safe",
            "case_id": "case-open-880",
            "snapshot_id": unresolved_snap_id,
            "question": "What is going on?",
            "protocol": "Do not invent a root cause.",
            "protocol_version": "v1",
            "visibility": {
                "visible_item_ids": ["ev-log-u"],
                "include_summaries": false,
                "include_raw_bytes": true
            },
            "created_at": "2026-01-16T07:00:00Z"
        }),
    );
    let task_out = bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-task",
            unresolved_task.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let unresolved_task_id = String::from_utf8(task_out.stdout)
        .unwrap()
        .trim()
        .to_string();
    let unresolved_run = seed.tmp.path().join("unresolved-run.json");
    write_json(
        &unresolved_run,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": unresolved_task_id,
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
            "raw_output_utf8": "Evidence shows errors; cause unknown.",
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "known", "value": "no agreed root cause" },
            "fairness": { "kind": "same_snapshot" },
            "status": "unscorable",
            "operator": "alice",
            "privacy": "share_safe",
            "created_at": "2026-01-16T08:00:00Z"
        }),
    );
    let run_out = bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-run",
            unresolved_run.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        run_out.status.success(),
        "{}",
        String::from_utf8_lossy(&run_out.stderr)
    );
    let unresolved_run_id = String::from_utf8(run_out.stdout)
        .unwrap()
        .trim()
        .strip_prefix("created ")
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_string();
    let adj_unresolved = json!({
        "schema_id": "contextdesk.triage_bench.adjudication.v1",
        "privacy": "share_safe",
        "case_id": "case-open-880",
        "task_id": unresolved_task_id,
        "snapshot_id": unresolved_snap_id,
        "run_id": unresolved_run_id,
        "reviewer": "reviewer-a",
        "conflict_of_interest": { "declared": false },
        "rubric_version": "contextdesk.triage_bench.rubric.v1",
        "phase": "support",
        "blinding": { "kind": "blinded" },
        "outcomes": outcomes(
            json!({"kind": "not_applicable"}),
            json!({"kind": "score", "value": 2}),
            json!({"kind": "score", "value": 1}),
            json!({"kind": "score", "value": 3}),
            json!({"kind": "score", "value": 3}),
        ),
        "created_at": "2026-01-16T10:00:00Z"
    });
    let (adj_u_id, _) = seed.import_adj(&adj_unresolved);
    let shown_u = seed.show("adjudications", &adj_u_id);
    assert_eq!(shown_u["outcomes"][0]["verdict"]["kind"], "not_applicable");
    assert_eq!(shown_u["outcomes"][1]["verdict"]["value"], 2);
    assert_eq!(shown_u["outcomes"][3]["verdict"]["value"], 3);

    let rubric =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("docs/RUBRIC_V1.md"))
            .unwrap();
    assert!(rubric.contains("contextdesk.triage_bench.rubric.v1"));
    assert!(rubric.contains("contextdesk.triage_bench.score_review.v1"));
    assert!(rubric.contains("diagnosis_correctness"));
    assert_eq!(fs::read(&seed.home_file).unwrap(), b"must remain unchanged");
}

#[test]
fn issue_880_unresolved_diagnosis_score_is_rejected() {
    let seed = Seeded::new();
    let unresolved_case = seed.tmp.path().join("bad-unresolved.json");
    write_json(
        &unresolved_case,
        &json!({
            "schema_id": "contextdesk.triage_bench.case.v1",
            "case_id": "case-open-bad",
            "privacy": "share_safe",
            "title": "open",
            "reported_problem": { "summary": "unknown" },
            "lifecycle": "unresolved",
            "timeline_notes": [],
            "created_at": "2026-01-16T00:00:00Z"
        }),
    );
    bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-case",
            unresolved_case.to_str().unwrap(),
        ])
        .assert()
        .success();
    let digest = cd_triage_bench::types::ContentDigest::of_bytes(LOG_BYTES);
    let snap = seed.tmp.path().join("bad-snap.json");
    write_json(
        &snap,
        &json!({
            "schema_id": "contextdesk.triage_bench.evidence_snapshot.v1",
            "privacy": "share_safe",
            "case_id": "case-open-bad",
            "captured_at": "2026-01-16T06:00:00Z",
            "captured_by": "cli",
            "items": [{
                "kind": "log",
                "item_id": "ev-log-b",
                "privacy": "share_safe",
                "capture_time": "2026-01-16T04:12:00Z",
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
    let blob = seed.tmp.path().join("app.log");
    fs::write(&blob, LOG_BYTES).unwrap();
    let snap_id = String::from_utf8(
        bench()
            .env("HOME", &seed.home_file)
            .args([
                "--library",
                seed.library.to_str().unwrap(),
                "import-snapshot",
                snap.to_str().unwrap(),
                "--blob",
                blob.to_str().unwrap(),
            ])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let task = seed.tmp.path().join("bad-task.json");
    write_json(
        &task,
        &json!({
            "schema_id": "contextdesk.triage_bench.evaluation_task.v1",
            "privacy": "share_safe",
            "case_id": "case-open-bad",
            "snapshot_id": snap_id,
            "question": "What?",
            "protocol": "no invented cause",
            "protocol_version": "v1",
            "visibility": {
                "visible_item_ids": ["ev-log-b"],
                "include_summaries": false,
                "include_raw_bytes": true
            },
            "created_at": "2026-01-16T07:00:00Z"
        }),
    );
    let task_id = String::from_utf8(
        bench()
            .env("HOME", &seed.home_file)
            .args([
                "--library",
                seed.library.to_str().unwrap(),
                "import-task",
                task.to_str().unwrap(),
            ])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .to_string();
    let run = seed.tmp.path().join("bad-run.json");
    write_json(
        &run,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": task_id,
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
            "raw_output_utf8": "unknown",
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "fairness": { "kind": "same_snapshot" },
            "status": "partial",
            "operator": "alice",
            "privacy": "share_safe",
            "created_at": "2026-01-16T08:00:00Z"
        }),
    );
    let run_id = String::from_utf8(
        bench()
            .env("HOME", &seed.home_file)
            .args([
                "--library",
                seed.library.to_str().unwrap(),
                "import-run",
                run.to_str().unwrap(),
            ])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    let run_id = run_id
        .trim()
        .strip_prefix("created ")
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_string();
    let adj = seed.tmp.path().join("bad-adj.json");
    write_json(
        &adj,
        &json!({
            "schema_id": "contextdesk.triage_bench.adjudication.v1",
            "privacy": "share_safe",
            "case_id": "case-open-bad",
            "task_id": task_id,
            "snapshot_id": snap_id,
            "run_id": run_id,
            "reviewer": "reviewer-a",
            "conflict_of_interest": { "declared": false },
            "rubric_version": "contextdesk.triage_bench.rubric.v1",
            "phase": "support",
            "blinding": { "kind": "blinded" },
            "outcomes": outcomes(
                json!({"kind": "score", "value": 2}),
                json!({"kind": "score", "value": 2}),
                json!({"kind": "score", "value": 1}),
                json!({"kind": "score", "value": 2}),
                json!({"kind": "score", "value": 2}),
            ),
            "created_at": "2026-01-16T10:00:00Z"
        }),
    );
    bench()
        .env("HOME", &seed.home_file)
        .args([
            "--library",
            seed.library.to_str().unwrap(),
            "import-adjudication",
            adj.to_str().unwrap(),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("diagnosis_correctness"));
}
