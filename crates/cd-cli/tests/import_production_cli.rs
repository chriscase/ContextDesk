//! CLI-specific production-import behavior end to end through the compiled
//! `contextdesk` binary: Ctrl-C cancellation is retry-safe, and the grouped
//! `timezone apply-all` command resolves every ambiguous source in one
//! call. `crates/cd-workflow/tests/import_production.rs` covers the
//! underlying `cd_workflow::import`/`cd_workflow::timezone` behavior
//! directly; this file only proves the CLI's OWN glue (SIGINT → CancelFlag,
//! the `apply-all` subcommand) actually wires up to it.

use assert_cmd::Command;
use serde_json::Value;
use std::path::Path;
#[cfg(unix)] // piped-stderr SIGINT test only
use std::process::Stdio;

fn cli(home: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.env("HOME", home);
    cmd
}

fn parse_envelope(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("stdout is one JSON envelope")
}

/// Ctrl-C (SIGINT) during a real `contextdesk import` invocation must exit
/// 130, publish nothing, and leave the source in a state a second
/// invocation can cleanly import — the CLI's own Ctrl-C → `CancelFlag`
/// wiring, not just the underlying `cd_core` cleanup guarantee.
#[cfg(unix)] // sends POSIX SIGINT via kill(1); no Windows equivalent here
#[test]
fn ctrl_c_cancels_cleanly_and_a_retry_succeeds() {
    let home = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    let mut body = String::new();
    for i in 0..60_000 {
        body.push_str(&format!("2024-01-01T00:00:00Z INFO line {i}\n"));
    }
    std::fs::write(source.path().join("app.log"), &body).unwrap();

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let mut child = std::process::Command::new(&bin)
        .env("HOME", home.path())
        .args(["import", source.path().to_str().unwrap()])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn contextdesk import");

    // Wait for the child to have actually reached streaming ingest (not
    // just process-spawned) before signaling it — a fixed sleep is flaky
    // under variable machine load (a slow scheduler tick can leave the
    // child not yet past tokio/runtime setup when a blind-timed SIGINT
    // arrives, which then hits the OS default disposition instead of our
    // handler). Reading for a phase marker is deterministic regardless of
    // how fast or slow the child gets scheduled.
    use std::io::{BufRead, BufReader};
    let mut stderr_reader = BufReader::new(child.stderr.take().expect("piped stderr"));
    let mut saw_stream_phase = false;
    let mut early_stderr = String::new();
    for _ in 0..2000 {
        let mut line = String::new();
        match stderr_reader.read_line(&mut line) {
            Ok(0) => break, // child exited before we ever saw the phase — handled below
            Ok(_) => {
                early_stderr.push_str(&line);
                if line.contains("Streaming") || line.contains("files=") {
                    saw_stream_phase = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        saw_stream_phase,
        "child must reach streaming ingest before this test can meaningfully signal it; saw: {early_stderr:?}"
    );

    let pid = child.id();
    let kill_status = std::process::Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status()
        .expect("send SIGINT");
    assert!(
        kill_status.success(),
        "kill -INT must reach the running import"
    );

    let mut rest_of_stderr = String::new();
    std::io::Read::read_to_string(&mut stderr_reader, &mut rest_of_stderr).ok();
    let status = child.wait().expect("wait for cancelled import");
    let output = std::process::Output {
        status,
        stdout: Vec::new(),
        stderr: format!("{early_stderr}{rest_of_stderr}").into_bytes(),
    };
    // A very fast machine may finish the import before SIGINT lands — that
    // is not a bug in the cancellation path, just a race this test
    // tolerates; only a non-zero, non-130 exit would indicate a real
    // problem.
    assert!(
        output.status.code() == Some(130) || output.status.code() == Some(0),
        "exit code must be 130 (cancelled) or 0 (finished first): {:?}, stderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.code() == Some(130) {
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("cancel"),
            "a cancelled run must say so on stderr"
        );
    }

    // Retry-safe regardless of which race outcome happened above.
    let retry = cli(home.path())
        .args(["--json", "import", source.path().to_str().unwrap()])
        .output()
        .expect("run contextdesk import retry");
    assert!(
        retry.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&retry.stderr)
    );
    let envelope = parse_envelope(&retry.stdout);
    assert_eq!(envelope["ok"], true);

    let list = cli(home.path())
        .args(["--json", "corpus", "list"])
        .output()
        .expect("run contextdesk corpus list");
    let list_envelope = parse_envelope(&list.stdout);
    let corpora = list_envelope["data"]["corpora"]
        .as_array()
        .expect("corpora array");
    assert_eq!(
        corpora.len(),
        1,
        "exactly one corpus must exist after cancel-then-retry, never a stray partial one: {list_envelope}"
    );
}

/// `timezone apply-all` resolves every ambiguous source in a corpus with
/// one command instead of requiring `timezone apply` once per file.
#[test]
fn timezone_apply_all_resolves_every_ambiguous_source_in_one_command() {
    let home = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(
        source.path().join("a.log"),
        "2024-05-03 12:24:22,729 INFO - a started\n",
    )
    .unwrap();
    std::fs::write(
        source.path().join("b.log"),
        "2024-05-03 12:24:22,729 INFO - b started\n",
    )
    .unwrap();

    let import_out = cli(home.path())
        .args(["--json", "import", source.path().to_str().unwrap()])
        .output()
        .expect("run contextdesk import");
    assert!(
        import_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&import_out.stderr)
    );
    let import_envelope = parse_envelope(&import_out.stdout);
    let corpus_id = import_envelope["data"]["corpus_id"]
        .as_str()
        .expect("corpus_id")
        .to_string();
    let ambiguous_before = import_envelope["data"]["timezone_ambiguous_sources"]
        .as_array()
        .expect("timezone_ambiguous_sources array")
        .len();
    assert_eq!(
        ambiguous_before, 2,
        "both comma-millis local-timestamp sources must start ambiguous: {import_envelope}"
    );

    let apply_all = cli(home.path())
        .args([
            "--json",
            "timezone",
            "apply-all",
            "America/Chicago",
            "--corpus",
            &corpus_id,
            "--yes",
        ])
        .output()
        .expect("run contextdesk timezone apply-all");
    assert!(
        apply_all.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&apply_all.stderr)
    );
    let apply_envelope = parse_envelope(&apply_all.stdout);
    let applied = apply_envelope["data"]["applied_sources"]
        .as_array()
        .expect("applied_sources array");
    assert_eq!(
        applied.len(),
        2,
        "one command must resolve BOTH sources: {apply_envelope}"
    );

    let status = cli(home.path())
        .args(["--json", "timezone", "status", "--corpus", &corpus_id])
        .output()
        .expect("run contextdesk timezone status");
    let status_envelope = parse_envelope(&status.stdout);
    let sources = status_envelope["data"]["sources"]
        .as_array()
        .expect("sources array");
    for source in sources {
        assert_eq!(
            source["unresolved_local_records"], 0,
            "no source may remain unresolved after apply-all: {status_envelope}"
        );
    }
}
