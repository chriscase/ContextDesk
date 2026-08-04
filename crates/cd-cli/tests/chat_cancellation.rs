//! Real-signal Ctrl-C coverage for `chat`, mirroring
//! `import_production_cli.rs`'s established `ctrl_c_cancels_cleanly_and_a_
//! retry_succeeds` shape: spawn the real binary, wait for a deterministic
//! phase marker on stderr (never a fixed sleep — flaky under variable
//! scheduling), send a real `SIGINT`, then assert the process exits through
//! the documented `cancelled` category rather than hanging, crashing, or
//! fabricating a success.
//!
//! Boundedness discipline (every wait in this file obeys this): never call a
//! blocking `wait()`/`read_to_string()` before the child's exit is already
//! proven by a bounded poll. On a deadline, forcibly kill and reap the
//! child, then fail the test with whatever output was captured — a bug in
//! `contextdesk` must show up as a failing assertion, never as this suite
//! hanging.

use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Bounded wait for a child to exit — polls `try_wait` rather than blocking,
/// so a hung child can never stall the caller past `timeout`.
fn wait_timeout(
    child: &mut Child,
    timeout: Duration,
) -> std::io::Result<Option<std::process::ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Bounded wait, with a kill-and-reap fallback on timeout — the one place in
/// this file allowed to give up on a child rather than hang. Returns the
/// exit status if the child exited on its own within `timeout`; `None` if it
/// had to be forcibly killed. Reaping after `kill()` still uses a bounded
/// poll (never a raw blocking `wait()`), since a genuinely wedged child (e.g.
/// stuck in an uninterruptible syscall) could in principle survive `kill()`
/// for longer than a test should wait.
fn wait_or_kill(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    if let Ok(Some(status)) = wait_timeout(child, timeout) {
        return Some(status);
    }
    let _ = child.kill();
    let _ = wait_timeout(child, Duration::from_secs(5));
    None
}

/// Read whatever is currently buffered on a pipe without blocking past
/// `budget` — used only after the child's exit is already confirmed (its end
/// of the pipe is closed, so a normal `read_to_string` would return promptly
/// regardless), kept bounded anyway so this helper is safe to reuse even if
/// a future caller has not yet confirmed exit.
fn drain_bounded<R: Read + Send + 'static>(mut reader: R, budget: Duration) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = reader.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    rx.recv_timeout(budget).unwrap_or_default()
}

#[tokio::test]
async fn ctrl_c_cancels_a_chat_turn_cleanly_instead_of_hanging_or_faking_success() {
    let server = MockServer::start().await;
    // A long, real delay before any response body arrives — the window this
    // test needs to reliably land its SIGINT while the turn is genuinely in
    // flight, not racing process startup.
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(20)))
        .mount(&server)
        .await;

    let home = tempfile::tempdir().unwrap();
    let app_config_path = home.path().join("config.json");
    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = server.uri();
    profile.local_only = true;
    profile.chat_model = "test-model".into();
    profile.capabilities.tools = false;
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    save_config(&app_config_path, &cfg).expect("write app config");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let mut child = std::process::Command::new(&bin)
        .env("HOME", home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "chat",
            "hi there",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn contextdesk chat");

    // Deterministic readiness marker: `render::ChatStatusRenderer::start()`
    // prints "Connecting to provider" before the turn does anything else, so
    // once it appears the child is definitely inside the async runtime and
    // past its Ctrl-C handler installation.
    let mut stderr_reader = BufReader::new(child.stderr.take().expect("piped stderr"));
    let mut saw_connecting = false;
    let mut early_stderr = String::new();
    let read_deadline = Instant::now() + Duration::from_secs(15);
    for _ in 0..2000 {
        if Instant::now() >= read_deadline {
            break;
        }
        let mut line = String::new();
        match stderr_reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                early_stderr.push_str(&line);
                if line.contains("Connecting to provider") {
                    saw_connecting = true;
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if !saw_connecting {
        let _ = wait_or_kill(&mut child, Duration::from_secs(5));
        panic!(
            "child must reach the renderer's initial line before this test can \
             meaningfully signal it; saw: {early_stderr:?}"
        );
    }
    // The renderer's first line proves the async runtime is up, but not that
    // `tokio::signal::ctrl_c()`'s handler has completed installing (a real,
    // if narrow, startup race — irrelevant to a real human, who takes far
    // longer than this to react, but observed to matter here by a fraction
    // of a millisecond, worse under the parallel load of the full test suite
    // running many subprocesses at once). A generous settle margin makes
    // this test reliable without weakening what it proves — a few hundred ms
    // of one-time setup cost is immaterial next to the 20s mock delay this
    // test also relies on.
    std::thread::sleep(Duration::from_millis(750));

    let pid = child.id();
    let kill_status = std::process::Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status()
        .expect("send SIGINT");
    assert!(
        kill_status.success(),
        "kill -INT must reach the running chat"
    );

    // Bounded wait FIRST — exit is proven (or the child is forcibly killed
    // and reaped) before any further read is attempted, so a regression that
    // makes the child hang after SIGINT fails this test instead of hanging
    // the suite.
    let status = wait_or_kill(&mut child, Duration::from_secs(10));
    let rest_of_stderr = drain_bounded(stderr_reader, Duration::from_secs(5));
    let full_stderr = format!("{early_stderr}{rest_of_stderr}");

    let status = status.unwrap_or_else(|| {
        panic!(
            "chat did not exit within 10s after SIGINT and had to be killed: \
             {full_stderr:?}"
        )
    });

    assert_eq!(
        status.code(),
        Some(130),
        "a cancelled turn must exit with the documented `cancelled` category \
         (130), not hang, crash, or report success: status={status:?} \
         stderr={full_stderr:?}"
    );
    assert!(
        full_stderr.contains("cancelling"),
        "the cancellation must announce itself: {full_stderr:?}"
    );
    assert!(
        full_stderr.contains("cancelled"),
        "the final line must say `cancelled`, never `done`: {full_stderr:?}"
    );
    assert!(
        !full_stderr.contains("done ·"),
        "a cancelled turn must never render the success completion line: \
         {full_stderr:?}"
    );
}

/// Mutation-style proof that this file's own bounded-wait mechanism cannot
/// be defeated by a child that never exits: spawn a process that ignores
/// ordinary termination signals until forcibly killed, and confirm
/// `wait_or_kill` still returns within its stated bound (never hangs the
/// caller) and reports the kill (`status.is_none()`), rather than silently
/// waiting forever. If `wait_or_kill`'s deadline check or `kill()` call were
/// ever removed or broken, this test — unlike the happy-path test above,
/// which only proves `contextdesk` itself is well-behaved — would be the one
/// to hang, making a regression to the harness itself impossible to miss
/// silently.
#[test]
fn a_hanging_child_cannot_hang_the_suite() {
    let mut child = std::process::Command::new("sh")
        .args([
            "-c",
            // Ignore SIGTERM/SIGINT and sleep far longer than any bound this
            // test applies — only SIGKILL (what `Child::kill` sends) can end
            // this process.
            "trap '' TERM INT; sleep 120",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn a deliberately unkillable-by-signal child");

    let started = Instant::now();
    // A short bound: this must return promptly via the kill fallback, not
    // by coincidentally winning a race against the 120s sleep.
    let status = wait_or_kill(&mut child, Duration::from_millis(500));
    let elapsed = started.elapsed();

    assert!(
        status.is_none(),
        "the child ignores TERM/INT and must have been force-killed, not \
         exited on its own: {status:?}"
    );
    assert!(
        elapsed < Duration::from_secs(10),
        "wait_or_kill must return promptly via its kill-and-reap fallback, \
         never block for anywhere near the child's 120s sleep: {elapsed:?}"
    );
}
