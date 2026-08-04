//! Real-pty coverage for `render::ChatStatusRenderer`.
//!
//! Every other test in this crate drives the compiled binary via
//! `assert_cmd`/`std::process::Command` with piped stdio — a process with
//! no controlling terminal, exactly the condition `cli_isolation.rs`
//! already documents (`assert_cmd` never attaches a tty). That proves the
//! **redirected** degrade path (`chat_interactive_renderer.rs`), but the
//! in-place-redraw path (`TerminalCapabilities::interactive == true`,
//! `\r` + `\x1b[2K` redraws) is structurally unobservable there — nothing
//! else in this workspace's test suite can exercise it. This file attaches
//! the real binary to a genuine pseudo-terminal (`portable_pty`) so that
//! code path actually runs at least once, end to end.
//!
//! Uses `chat --dry-run` rather than a mocked HTTP provider:
//! `cd_workflow::chat::run_chat_workflow` drives the exact same
//! `StreamEvent` lifecycle (`TurnStarted`/`TurnPhase`/`TurnCompleted`)
//! under `--dry-run` as a real turn — only the backend never makes a
//! network call (`docs/CLI.md`'s `--dry-run` section) — so this is
//! deterministic and network-free while still exercising the renderer
//! exactly the way a real turn would.

use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn interactive_pty_chat_redraws_in_place_and_ends_clean() {
    let home = tempfile::tempdir().expect("tempdir");
    let app_config_path = home.path().join("config.json");
    let profile = ProviderProfile::ollama_local();
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    save_config(&app_config_path, &cfg).expect("write app config");

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open a pty pair");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let mut cmd = CommandBuilder::new(bin);
    cmd.env("HOME", home.path());
    // `CommandBuilder::new` starts from the PARENT process's full
    // environment (`portable_pty::cmdbuilder::get_base_env`), not a clean
    // slate — this test asserts the capable-terminal path specifically, so
    // it must not depend on whatever `TERM`/`NO_COLOR` happen to be set to
    // in whichever environment `cargo test` itself runs under. `TERM=dumb`
    // inherited from the parent shell, for one real example, made this
    // exact test fail here — the product was correctly suppressing redraw
    // for a genuinely non-capable terminal, while this test still expected
    // the capable-terminal redraw sequence. `render::TerminalCapabilities`
    // reads only these two variables (see its own `detect`), so only these
    // two need to be pinned. `NO_COLOR` is cleared, not set — an inherited
    // `NO_COLOR=1` must never be read as "also disable redraw"; per
    // `TerminalCapabilities::from_parts`, it only ever disables color.
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("NO_COLOR");
    cmd.args([
        "--app-config",
        app_config_path.to_str().expect("utf8 path"),
        "chat",
        "hi there",
        "--dry-run",
    ]);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .expect("spawn contextdesk under a real pty");
    // The slave end belongs to the child now; dropping this side is what
    // lets the master reader see EOF once the child exits instead of
    // hanging on a fd this process itself still holds open.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("clone pty reader");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut output = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    break;
                }
                if let Ok(Some(_)) = child.try_wait() {
                    // Drain whatever already arrived, then stop — no more
                    // is coming once the child has exited and the reader
                    // thread will end on its own EOF shortly after.
                    while let Ok(chunk) = rx.try_recv() {
                        output.extend_from_slice(&chunk);
                    }
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Bounded reap: the loop above already confirmed exit via `try_wait` on
    // the happy path, but on the 20s read-deadline path it may not have —
    // `reap_or_kill` never calls a blocking `wait()`, and force-kills plus
    // *confirms* the reap (rather than assuming `kill()` alone is enough) so
    // a regression that leaves the child running cannot hang this test or
    // leak a zombie process out of it.
    reap_or_kill(
        child.as_mut(),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );

    let text = String::from_utf8_lossy(&output).to_string();
    assert!(
        text.contains("Connecting to provider"),
        "expected the renderer's initial status line under a real pty: {text:?}"
    );
    assert!(
        text.contains("\r\u{1b}[2K"),
        "expected at least one in-place redraw (\\r + ANSI clear-line) — \
         this is the one behavior only a real controlling terminal can \
         prove: {text:?}"
    );
    assert!(
        text.contains("done"),
        "expected the concise completion line: {text:?}"
    );

    // The pty must never be left holding a dangling, unterminated escape
    // sequence — the last meaningful line has to end cleanly.
    let last_nonempty = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    let stripped = last_nonempty.trim_end();
    assert!(
        !ends_mid_escape(stripped),
        "the terminal must never be left mid-escape-sequence at process \
         exit: {stripped:?}"
    );
}

/// The other half of the capable-terminal test above: a real controlling
/// terminal that identifies itself as `TERM=dumb` (e.g. Emacs' `shell-mode`)
/// must degrade to the SAME bounded, ANSI-free, one-line-per-transition
/// output `chat_interactive_renderer.rs`'s redirected-output tests already
/// prove for piped (non-tty) stdio — proving that degrade is driven by the
/// terminal's own declared capability, not merely by the absence of a
/// controlling terminal, which only a real pty (not `assert_cmd`) can
/// exercise. Uses `--dry-run` for the same reason the sibling test does:
/// deterministic and network-free while still driving the full
/// `StreamEvent` lifecycle a real turn would.
#[test]
fn interactive_pty_chat_with_term_dumb_degrades_to_bounded_plain_output() {
    let home = tempfile::tempdir().expect("tempdir");
    let app_config_path = home.path().join("config.json");
    let profile = ProviderProfile::ollama_local();
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    save_config(&app_config_path, &cfg).expect("write app config");

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open a pty pair");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let mut cmd = CommandBuilder::new(bin);
    cmd.env("HOME", home.path());
    // The one variable this test is actually about — pinned explicitly
    // rather than relying on inheriting it, so the test means the same
    // thing regardless of what shell/CI environment runs it.
    cmd.env("TERM", "dumb");
    // Irrelevant to `dumb`'s own degrade (color already goes false once
    // `interactive` is false — see `TerminalCapabilities::from_parts`), but
    // cleared anyway so this test's environment is fully explicit rather
    // than partially inherited.
    cmd.env_remove("NO_COLOR");
    cmd.args([
        "--app-config",
        app_config_path.to_str().expect("utf8 path"),
        "chat",
        "hi there",
        "--dry-run",
    ]);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .expect("spawn contextdesk under a real pty");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("clone pty reader");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut output = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    break;
                }
                if let Ok(Some(_)) = child.try_wait() {
                    while let Ok(chunk) = rx.try_recv() {
                        output.extend_from_slice(&chunk);
                    }
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Bounded reap on every exit path from this point — see the sibling
    // test's identical comment.
    reap_or_kill(
        child.as_mut(),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );

    let text = String::from_utf8_lossy(&output).to_string();
    assert!(
        !text.contains('\u{1b}'),
        "TERM=dumb must never emit an ANSI escape sequence, even under a \
         real controlling terminal: {text:?}"
    );
    assert!(
        !text.contains("\r\u{1b}[2K"),
        "TERM=dumb must never redraw in place: {text:?}"
    );
    // A real pty still translates this program's own `\n` writes into
    // `\r\n` (standard line-ending translation, not this program's doing —
    // see the sibling SSE test's identical note) — a bare `\r` with no ANSI
    // escape anywhere near it is exactly that, not an in-place redraw
    // artifact, so it is excluded here rather than asserted against.
    let bare_cr_outside_crlf = text.replace("\r\n", "").contains('\r');
    assert!(
        !bare_cr_outside_crlf,
        "TERM=dumb must never emit a bare carriage return used for \
         in-place redraw (only pty-translated \\r\\n line endings are \
         expected): {text:?}"
    );

    // Still readable and correct despite the degrade: the initial status,
    // and the concise completion line.
    assert!(
        text.contains("Connecting to provider"),
        "expected the renderer's initial status line even under TERM=dumb: \
         {text:?}"
    );
    assert!(
        text.contains("done"),
        "expected the concise completion line even under TERM=dumb: {text:?}"
    );

    // Bounded: a handful of short lines, never one line per internal event
    // (mirrors `chat_interactive_renderer.rs`'s identical redirected-output
    // assertion — TERM=dumb must degrade the same way redirection does).
    let status_lines: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter(|l| {
            l.contains("Connecting")
                || l.contains("Assembling")
                || l.contains("Waiting")
                || l.contains("Running tools")
                || l.contains("Validating")
                || l.contains("Saving")
                || l.contains("done")
                || l.contains("cancelled")
                || l.contains("failed")
        })
        .collect();
    assert!(
        status_lines.len() <= 6,
        "TERM=dumb output must stay bounded, not one line per internal \
         event: {status_lines:#?}"
    );
}

/// Regression coverage for a real bug: once the reply starts streaming
/// (`TextDelta`, printed via `print!` with no trailing newline), a later
/// phase-changing event on the SAME turn (here, `TurnCompleted`, which
/// always fires right after the last delta) used to force `redraw()` to
/// print anyway — concatenating a status word directly onto the end of the
/// visible reply on a real terminal, since stdout and stderr share one
/// cursor there. `--dry-run` (used by the sibling test above) never
/// exercises this: it produces no `TextDelta` at all, so it never
/// downgrades. This test uses a real (mocked) streaming provider instead,
/// so the reply genuinely streams to stdout before `TurnCompleted` and
/// `finish()` render to stderr — the only way to prove no concatenation
/// and no double blank line under the real, shared-cursor pty condition.
#[tokio::test]
async fn a_streamed_reply_is_never_concatenated_with_the_completion_line() {
    let server = MockServer::start().await;
    let sse_body = "data: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"from the mock model\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n";
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(sse_body, "text/event-stream"),
        )
        .mount(&server)
        .await;

    let home = tempfile::tempdir().expect("tempdir");
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

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open a pty pair");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let mut cmd = CommandBuilder::new(bin);
    cmd.env("HOME", home.path());
    // See the sibling capable-terminal test's comment on the same lines —
    // this test also exercises the interactive redraw/downgrade path and
    // must not depend on the parent process's inherited `TERM`/`NO_COLOR`.
    cmd.env("TERM", "xterm-256color");
    cmd.env_remove("NO_COLOR");
    cmd.args([
        "--app-config",
        app_config_path.to_str().expect("utf8 path"),
        "chat",
        "hi there",
    ]);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .expect("spawn contextdesk under a real pty");
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().expect("clone pty reader");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut output = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => output.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if Instant::now() >= deadline {
                    break;
                }
                if let Ok(Some(_)) = child.try_wait() {
                    while let Ok(chunk) = rx.try_recv() {
                        output.extend_from_slice(&chunk);
                    }
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    reap_or_kill(
        child.as_mut(),
        Duration::from_secs(5),
        Duration::from_secs(5),
    );

    // The pty echoes stdout/stderr in write order without a way to tell
    // them apart byte-for-byte, which is exactly the real terminal
    // condition this test exists to prove is handled correctly: if
    // anything here regresses, the reply text and a status word (or the
    // `done`/`cancelled`/`failed` line) will appear jammed onto the same
    // line, or separated by more than the one blank line the reply's own
    // trailing newline accounts for.
    let text = String::from_utf8_lossy(&output).to_string();
    assert!(
        text.contains("hello from the mock model"),
        "expected the full streamed reply to appear: {text:?}"
    );
    assert!(
        text.contains("done"),
        "expected the concise completion line: {text:?}"
    );

    // Simulate a terminal's carriage-return overwrite before splitting into
    // "visible" lines: `str::lines()` alone splits only on `\n`, so every
    // in-place `\r`-redraw before the reply started (all legitimate — a
    // real terminal shows only the LAST one, overwritten in place) would
    // otherwise collapse into one fake "line" together with the reply
    // text, which is not the concatenation bug this test exists to catch.
    // A real pty also converts every genuine `\n` this program writes into
    // `\r\n` (standard line-ending translation) — normalize that back to a
    // bare `\n` FIRST, or the `\r` collapse below would misread that
    // trailing `\r` as one more overwrite and erase the whole line.
    let visible = text
        .replace("\r\n", "\n")
        .split('\n')
        .map(|segment| segment.rsplit('\r').next().unwrap_or(segment).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let lines: Vec<&str> = visible.lines().collect();
    let reply_line_idx = lines
        .iter()
        .position(|l| l.contains("hello from the mock model"))
        .expect("a line containing the full reply");
    let reply_line = lines[reply_line_idx];
    // The regression this test exists to catch: a phase transition firing
    // after the last `TextDelta` (here, `TurnCompleted`, which always
    // follows the last delta) used to force a redraw anyway, appending its
    // status word directly onto the reply's own line.
    for phase_word in [
        "Connecting to provider",
        "Assembling context",
        "Waiting on model",
        "Running tools",
        "Validating grounded evidence",
        "Saving session",
        "cancelled",
        "failed",
    ] {
        assert!(
            !reply_line.contains(phase_word),
            "the reply's own line must never carry a concatenated status \
             word ({phase_word:?}): {reply_line:?}"
        );
    }
    // Only the reply itself, never `done` on the same line either — that
    // must be its own, separate terminal line.
    assert!(
        !reply_line.contains("done"),
        "the completion line must never be concatenated onto the reply's \
         own line: {reply_line:?}"
    );

    // Between the reply's line and the line bearing `done`, at most one
    // blank line — the reply's own trailing newline
    // (`commands::chat::run`'s `println!()`), never a second one added by
    // the renderer's own leading newline (which only applies on
    // `Cancelled`/`Failed`, not `Ok`).
    let done_line_idx = lines
        .iter()
        .position(|l| l.contains("done"))
        .expect("a line containing the completion result");
    let blank_lines_between = lines[reply_line_idx + 1..done_line_idx]
        .iter()
        .filter(|l| l.trim().is_empty())
        .count();
    assert!(
        blank_lines_between <= 1,
        "expected at most one blank line between the streamed reply and \
         the completion line on success, never a spurious extra blank \
         line: {:?}",
        &lines[reply_line_idx..=done_line_idx]
    );

    let last_nonempty = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("");
    assert!(
        !ends_mid_escape(last_nonempty.trim_end()),
        "the terminal must never be left mid-escape-sequence at process \
         exit: {last_nonempty:?}"
    );
}

/// Bounded reap for a `portable_pty` child: poll `try_wait` for up to
/// `poll_timeout`; if the child has not exited on its own by then, `kill()`
/// it and poll for up to `post_kill_timeout` more to *confirm* the reap —
/// never a blocking `wait()`, and never just trusting that `kill()` alone
/// collected the process. Panics with bounded diagnostic context if the
/// child is still not reaped after the post-kill window, since silently
/// returning in that case would let this helper's caller believe cleanup
/// succeeded when a zombie (or a still-running, merely signaled) process
/// was actually left behind.
///
/// `kill()` itself does not guarantee an *instantaneous* exit — even
/// `SIGKILL` (confirmed empirically to be what `portable_pty` actually
/// sends a real pty-spawned child on this platform) still needs the kernel
/// to schedule the process's teardown before `try_wait` observes it. The
/// post-kill loop exists precisely to CONFIRM that, rather than trusting
/// `kill()`'s `Ok(())` return as proof of exit — see
/// `a_child_that_never_reports_exit_still_cannot_hang_the_reap` below, which
/// proves that half of the contract deterministically, against a fake child
/// engineered to never report exit.
///
/// Returns `true` if the child exited on its own within `poll_timeout`,
/// `false` if it had to be force-killed (and the kill was confirmed).
fn reap_or_kill(
    child: &mut dyn portable_pty::Child,
    poll_timeout: Duration,
    post_kill_timeout: Duration,
) -> bool {
    let poll_deadline = Instant::now() + poll_timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < poll_deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => break,
        }
    }

    let _ = child.kill();
    let post_kill_deadline = Instant::now() + post_kill_timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return false,
            Ok(None) if Instant::now() < post_kill_deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            other => {
                panic!(
                    "child was not confirmed reaped within {post_kill_timeout:?} \
                     after kill() — a zombie or still-running process would \
                     otherwise be left behind: last try_wait() = {other:?}"
                )
            }
        }
    }
}

/// A fully-controlled fake `Child` for deterministic mutation testing of
/// `reap_or_kill`'s control flow — a real process's `SIGKILL` was confirmed
/// empirically (via a throwaway probe during this test's development) to be
/// reaped by `portable_pty` so eagerly (observed ~24ms after `kill()`, and
/// sometimes less) that racing it with a real timeout is not a reliable way
/// to prove anything: a `post_kill_timeout` tight enough to ever observe
/// "not yet reaped" is indistinguishable from ordinary scheduling jitter. A
/// fake removes the OS entirely: `try_wait` always reports "still running"
/// no matter how many times it is called or whether `kill` was already
/// called, so `reap_or_kill`'s post-kill loop is *guaranteed* to run out its
/// full budget — proving the loop actually polls until its deadline (and
/// then panics) rather than returning early on any other condition.
#[derive(Debug)]
struct NeverExitsChild {
    kill_calls: u32,
}

impl portable_pty::ChildKiller for NeverExitsChild {
    fn kill(&mut self) -> std::io::Result<()> {
        self.kill_calls += 1;
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        unimplemented!("not exercised by this test")
    }
}

impl portable_pty::Child for NeverExitsChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        Ok(None)
    }
    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        unimplemented!("not exercised by this test — reap_or_kill never calls a blocking wait")
    }
    fn process_id(&self) -> Option<u32> {
        None
    }
}

/// Mutation-style proof that `reap_or_kill`'s post-kill loop actually polls
/// for confirmation — and panics on a genuine deadline — rather than
/// trusting `kill()`'s `Ok(())` return as proof of exit. Against
/// `NeverExitsChild` (`try_wait` always `Ok(None)`, deterministically, no
/// real process or OS scheduling involved), any bound the caller supplies
/// MUST eventually run out and panic; there is no code path in a correct
/// implementation that could return `Ok`/`false` here. If the post-kill
/// confirmation loop in `reap_or_kill` were ever reverted to the earlier
/// bug this test guards against (`kill()` then an unconditional `return
/// false`), this exact scenario would instead return `false` **without
/// panicking** — this test's core assertion (`result.err()` must be `Some`)
/// would then fail, which is how that regression gets caught rather than
/// silently passing.
#[test]
fn a_child_that_never_reports_exit_still_cannot_hang_the_reap() {
    let mut child = NeverExitsChild { kill_calls: 0 };

    let started = Instant::now();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        reap_or_kill(
            &mut child,
            Duration::from_millis(100),
            Duration::from_millis(300),
        )
    }));
    let elapsed = started.elapsed();

    let panic_message = result
        .err()
        .and_then(|payload| {
            payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        })
        .expect(
            "reap_or_kill must panic against a child that never reports \
             exit — returning normally here would mean the post-kill loop \
             is not actually polling for confirmation, just trusting \
             kill()'s Ok(()) return",
        );
    assert!(
        panic_message.contains("not confirmed reaped"),
        "the panic must name the specific unreaped-child condition this test \
         exists to prove, not an unrelated failure: {panic_message:?}"
    );
    assert!(
        elapsed >= Duration::from_millis(300) && elapsed < Duration::from_secs(2),
        "reap_or_kill must actually spend its full post-kill budget polling \
         (proving the loop runs, not just an immediate panic that happens to \
         match the message) while still remaining bounded overall: {elapsed:?}"
    );
    assert_eq!(
        child.kill_calls, 1,
        "kill() must be called exactly once, before the post-kill polling \
         begins"
    );
}

/// True if `s` ends with an incomplete ANSI CSI sequence (an ESC, or
/// `ESC [` with no final byte yet) — the shape a corrupted terminal would
/// be left in if a redraw were interrupted mid-write.
fn ends_mid_escape(s: &str) -> bool {
    match s.rfind('\u{1b}') {
        None => false,
        Some(idx) => {
            let tail = &s[idx..];
            // A complete CSI sequence is ESC '[' <params> <final byte in
            // 0x40..=0x7E>. Anything shorter, or missing that final byte,
            // is a dangling sequence.
            if tail == "\u{1b}" {
                return true;
            }
            let rest = &tail[1..];
            if let Some(csi_body) = rest.strip_prefix('[') {
                !csi_body
                    .chars()
                    .last()
                    .is_some_and(|c| ('\u{40}'..='\u{7e}').contains(&c))
            } else {
                false
            }
        }
    }
}
