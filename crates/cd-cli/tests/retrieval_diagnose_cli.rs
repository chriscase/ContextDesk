//! Hermetic CLI contract for `contextdesk retrieval-diagnose`.
//!
//! Every case here runs the real binary in an isolated `--data-dir` with no
//! configured retrieval role, so nothing reaches a provider: the surface under
//! test is the dry-run default, the consent gates, and the honesty labels.

use assert_cmd::cargo::cargo_bin;
use assert_cmd::Command;
use std::path::Path;
use tempfile::TempDir;

fn bin() -> Command {
    Command::new(cargo_bin!("contextdesk"))
}

fn write_queries(dir: &Path) -> String {
    let path = dir.join("queries.json");
    std::fs::write(
        &path,
        r#"{"queries":[{
            "query_id":"storage",
            "question":"storage saturation disk free space",
            "keyword_terms":["storage saturation"],
            "truth":{
                "relevant_seqs":[2,4],
                "mandatory_anchor_seqs":[2],
                "decoy_seqs":[8]
            }
        }]}"#,
    )
    .expect("write queries");
    path.to_str().expect("utf8 path").to_string()
}

/// A corpus imported through the real CLI, so the diagnostic runs against
/// state the product actually produces.
fn import_corpus(data: &Path, work: &Path) -> String {
    std::fs::create_dir_all(data).expect("data dir");
    let source = work.join("logs");
    std::fs::create_dir_all(&source).expect("source dir");
    let mut lines = String::new();
    for (index, message) in [
        "routine heartbeat lane ok",
        "storage saturation disk free space collapsing",
        "routine heartbeat lane ok",
        "disk volume nearly full",
    ]
    .iter()
    .enumerate()
    {
        lines.push_str(&format!(
            "{{\"ts\":{},\"level\":\"info\",\"service\":\"diag\",\"message\":\"{message}\"}}\n",
            1_735_732_800 + index as i64 * 30
        ));
    }
    std::fs::write(source.join("app.jsonl"), lines).expect("source file");

    let out = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "import",
            source.to_str().unwrap(),
            "--name",
            "diag",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let envelope: serde_json::Value = serde_json::from_slice(&out).expect("import envelope");
    envelope["data"]["corpus_id"]
        .as_str()
        .or_else(|| envelope["data"]["report"]["corpus_id"].as_str())
        .unwrap_or_default()
        .to_string()
}

#[test]
fn a_bare_invocation_is_a_dry_run_that_touches_no_provider() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let queries = write_queries(tmp.path());
    let corpus = import_corpus(&data, tmp.path());
    assert!(!corpus.is_empty(), "import must publish a corpus id");

    let out = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let envelope: serde_json::Value = serde_json::from_slice(&out).expect("envelope");
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["command"], "retrieval_diagnose");
    let data_out = &envelope["data"];
    assert_eq!(data_out["dry_run"], true);
    assert_eq!(
        data_out["credentials_read"], false,
        "a plan must never read a credential"
    );
    assert_eq!(
        data_out["network"], false,
        "a plan must never touch the network"
    );
    assert_eq!(data_out["evidence"]["answer_usefulness"], "not_evaluated");
    assert_eq!(
        data_out["evidence"]["compatibility_readiness"],
        "not_evaluated"
    );

    let plan = &data_out["plan"];
    assert_eq!(plan["corpus_id"], corpus);
    assert_eq!(plan["lanes"].as_array().unwrap().len(), 6);
    assert_eq!(plan["requires_egress_consent"], false);
    // No role is configured in this profile, so every lane needing one is
    // named as blocked rather than silently skipped.
    let blocked = plan["blocked_lanes"].as_array().unwrap();
    assert!(!blocked.is_empty());
    assert!(blocked
        .iter()
        .any(|entry| entry["code"] == "embedding_role_unconfigured"));
    assert!(blocked
        .iter()
        .any(|entry| entry["code"] == "rerank_role_unconfigured"));
}

#[test]
fn the_text_plan_states_what_ran_and_what_was_not_evaluated() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let queries = write_queries(tmp.path());
    let corpus = import_corpus(&data, tmp.path());

    let out = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--no-color",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let text = String::from_utf8(out).expect("utf8");

    assert!(text.contains("plan (dry run)"));
    assert!(text.contains("Nothing ran."));
    assert!(text.contains("--confirm"));
    assert!(text.contains("Answer usefulness:       not evaluated"));
    assert!(text.contains("Compatibility/readiness: not evaluated"));
    assert!(
        text.contains("Every configured role is loopback"),
        "locality copy must be explicit: {text}"
    );
    // `--no-color` output carries no ANSI escapes.
    assert!(!text.contains('\u{1b}'), "no-color output must be plain");
    // A report a user might paste never carries an absolute path.
    assert!(!text.contains(data.to_str().unwrap()));
}

#[test]
fn raw_output_requires_two_separate_consents() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let queries = write_queries(tmp.path());
    let corpus = import_corpus(&data, tmp.path());

    let assert = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
            "--include-raw",
        ])
        .assert()
        .failure();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let envelope: serde_json::Value = serde_json::from_str(&stdout).expect("error envelope");
    assert_eq!(envelope["ok"], false);
    let message = envelope["error"]["message"].as_str().unwrap_or_default();
    assert!(
        message.contains("--raw-output-is-not-share-safe"),
        "the refusal must name the second consent: {message}"
    );
    assert!(message.contains("not \nsafe to share") || message.contains("not safe to share"));

    // Both flags together are accepted (still a dry run, so nothing runs).
    bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
            "--include-raw",
            "--raw-output-is-not-share-safe",
        ])
        .assert()
        .success();
}

#[test]
fn an_invalid_lane_or_missing_query_file_fails_before_anything_runs() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let queries = write_queries(tmp.path());
    let corpus = import_corpus(&data, tmp.path());

    let assert = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
            "--lane",
            "semantic",
        ])
        .assert()
        .failure();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(stdout.contains("unknown lane"));
    assert!(stdout.contains("hybrid_rrf"), "the refusal lists the lanes");

    let missing = tmp.path().join("absent.json");
    let assert = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            missing.to_str().unwrap(),
            "--corpus-id",
            &corpus,
        ])
        .assert()
        .failure();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(stdout.contains("absent.json"));
    assert!(
        !stdout.contains(tmp.path().to_str().unwrap()),
        "an error must not echo the absolute path"
    );
}

#[test]
fn confirming_without_a_usable_lane_is_inconclusive_not_a_pass() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let queries = write_queries(tmp.path());
    let corpus = import_corpus(&data, tmp.path());

    // No embedder and no reranker are configured, so only the keyword baseline
    // can run: one usable lane is not a comparison.
    let assert = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
            "--confirm",
        ])
        .assert()
        .code(8);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    let envelope: serde_json::Value = serde_json::from_str(&stdout).expect("envelope");
    assert_eq!(envelope["ok"], true, "the command itself did not fail");
    let report = &envelope["data"]["report"];
    assert_eq!(report["verdict"], "inconclusive");
    assert_eq!(report["schema_id"], "contextdesk.retrieval_diagnostic.v1");
    assert_eq!(
        report["evidence"]["answer_usefulness"], "not_evaluated",
        "a run never upgrades its own evidence class"
    );

    // The keyword baseline still produced measured rows.
    let lanes = report["lanes"].as_array().unwrap();
    let baseline = lanes
        .iter()
        .find(|lane| lane["lane"] == "keyword_baseline")
        .expect("baseline lane present");
    assert_ne!(baseline["status"], "blocked");
    assert_eq!(baseline["engine"], "tool_host_search_logs");
}

#[test]
fn a_written_report_is_share_safe_and_refuses_to_clobber() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let queries = write_queries(tmp.path());
    let corpus = import_corpus(&data, tmp.path());
    let output = tmp.path().join("diag-report.json");

    bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
            "--confirm",
            "--output",
            output.to_str().unwrap(),
        ])
        .assert()
        .code(8);
    let body = std::fs::read_to_string(&output).expect("report written");
    let report: serde_json::Value = serde_json::from_str(&body).expect("valid json report");
    assert_eq!(report["schema_id"], "contextdesk.retrieval_diagnostic.v1");
    assert!(
        !body.contains("/Users/"),
        "no absolute path in the artifact"
    );
    assert!(
        !body.contains(data.to_str().unwrap()),
        "no data-dir path in the artifact"
    );
    assert!(
        !body.contains("storage saturation disk free space collapsing"),
        "no corpus text in the artifact"
    );

    // A second run refuses to overwrite without --force.
    let assert = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
            "--confirm",
            "--output",
            output.to_str().unwrap(),
        ])
        .assert()
        .failure();
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).unwrap();
    assert!(stdout.contains("already exists"));
    assert!(stdout.contains("diag-report.json"));
    assert!(
        !stdout.contains(tmp.path().to_str().unwrap()),
        "the refusal names the basename, not the path"
    );
}

#[test]
fn jsonl_report_lines_each_carry_the_corpus_identity() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let queries = write_queries(tmp.path());
    let corpus = import_corpus(&data, tmp.path());
    let output = tmp.path().join("diag-report.jsonl");

    bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-diagnose",
            "--queries",
            &queries,
            "--corpus-id",
            &corpus,
            "--confirm",
            "--output",
            output.to_str().unwrap(),
            "--report-format",
            "jsonl",
        ])
        .assert()
        .code(8);
    let body = std::fs::read_to_string(&output).expect("report written");
    let lines: Vec<&str> = body
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    assert!(lines.len() >= 2, "header plus one line per lane");
    let header: serde_json::Value = serde_json::from_str(lines[0]).expect("header line");
    assert_eq!(header["record"], "header");
    assert_eq!(header["corpus"]["corpus_id"], corpus);
    for line in &lines[1..] {
        let row: serde_json::Value = serde_json::from_str(line).expect("lane line");
        assert_eq!(row["record"], "lane");
        assert_eq!(
            row["corpus_id"], corpus,
            "a lane row is never readable without its corpus"
        );
    }
}
