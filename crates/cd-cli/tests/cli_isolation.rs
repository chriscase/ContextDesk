//! Adversarial proof for `--data-dir` / `--profile-dir` isolation and the
//! upgraded `config init` wizard.
//!
//! Every claim here is checked against the compiled `contextdesk` binary
//! (not the library directly) because the property under test is what a
//! real invocation does, including argument parsing and stdout shape.
//!
//! Two things worth knowing about scope:
//! - `--data-dir` isolation does not need the OS home/profile directory (see
//!   [`an_isolated_profile_never_consults_home`]). The black-box test below
//!   poisons `$HOME` where that variable is meaningful; the paired unit test
//!   in `adapters::path_tests` proves on every platform that isolated path
//!   resolution never evaluates either shared-profile resolver.
//! - No test in this file ever passes `--api-key-env` / `--api-key-file` /
//!   `--api-key-stdin` to the compiled binary: that flow always calls the
//!   real OS keychain (`adapters::secret_store()` is not injectable from
//!   outside the process), which can block a headless run on a GUI
//!   authorization prompt — the same reason `cd_core::keychain_store`'s own
//!   test suite exercises only `MemorySecretStore`, never
//!   `KeychainSecretStore`, for anything beyond its service-name math.
//!   Credential redaction and keychain round-tripping are proven instead by
//!   the in-process unit tests in
//!   `crates/cd-cli/src/commands/config_cmd.rs` (`mod tests`), which call
//!   the same production `configure_provider_profile` / `run_init`
//!   functions directly with an injected `MemorySecretStore`.
//! - No test asserts a specific network outcome for a real remote host —
//!   the one connectivity-check test targets an always-local, normally
//!   closed loopback port so it stays deterministic without needing a
//!   mock server.

use assert_cmd::Command;
use serde_json::Value;
use std::path::Path;

fn cli() -> Command {
    Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace")
}

fn parse_envelope(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("stdout is one JSON envelope")
}

/// A profile id unique to this process+directory, so parallel tests (and
/// parallel CI runs) never collide on the same real keychain entry.
fn unique_profile_id(tag: &str, dir: &Path) -> String {
    format!(
        "cli-isolation-test-{tag}-{}",
        dir.file_name().and_then(|n| n.to_str()).unwrap_or("x")
    )
}

/// `--data-dir` must skip shared home/profile resolution entirely. On Unix,
/// `dirs::home_dir()` reads `$HOME`; on Windows it uses `FOLDERID_Profile`
/// and intentionally ignores `$HOME`. This process-level test therefore
/// combines a poisoned Unix home with exact isolated-path and non-mutation
/// assertions. The resolver-level test in `adapters::path_tests` supplies
/// the platform-independent negative proof that neither shared resolver is
/// evaluated.
#[test]
fn an_isolated_profile_never_consults_home() {
    let data_dir = tempfile::tempdir().unwrap();
    let poison = tempfile::tempdir().unwrap();
    let broken_home = poison.path().join("home-is-a-file");
    std::fs::write(&broken_home, b"must remain unchanged").unwrap();

    let isolated = cli()
        .env("HOME", &broken_home)
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
        ])
        .output()
        .unwrap();
    assert!(
        isolated.status.success(),
        "an isolated profile must succeed even with a broken $HOME: {}",
        String::from_utf8_lossy(&isolated.stderr)
    );
    let envelope = parse_envelope(&isolated.stdout);
    assert!(envelope["ok"].as_bool().unwrap());
    assert!(envelope["data"]["isolated"].as_bool().unwrap());
    assert!(data_dir.path().join("cli.toml").is_file());
    assert_eq!(
        std::fs::read(&broken_home).unwrap(),
        b"must remain unchanged",
        "isolated startup must not mutate the poisoned home/profile sentinel"
    );
}

/// `--profile-dir` is documented as an alias for `--data-dir` — prove they
/// are exactly interchangeable, not two flags that happen to look similar.
#[test]
fn profile_dir_is_a_true_alias_for_data_dir() {
    let dir = tempfile::tempdir().unwrap();
    let output = cli()
        .args([
            "--profile-dir",
            dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let envelope = parse_envelope(&output.stdout);
    assert_eq!(
        envelope["data"]["data_dir"].as_str().unwrap(),
        dir.path().to_str().unwrap()
    );
    assert!(envelope["data"]["isolated"].as_bool().unwrap());
}

/// Two isolated profiles must be fully independent: creating and activating
/// a provider in profile A must leave profile B's directory untouched — not
/// merely "showing different values" but literally no file written there.
#[test]
fn two_isolated_profiles_cannot_read_or_modify_each_other() {
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let profile_id = unique_profile_id("cross", a.path());

    let init_a = cli()
        .args([
            "--data-dir",
            a.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "ollama",
            "--chat-model",
            "llama3",
            "--profile-id",
            &profile_id,
        ])
        .output()
        .unwrap();
    assert!(init_a.status.success());

    // B's data dir gets created by Paths::resolve (fs::create_dir_all), but
    // nothing inside it — no config.json, no cli.toml — until B does its
    // own write.
    assert!(
        !b.path().join("config.json").exists(),
        "profile B must not gain a config.json from profile A's writes"
    );
    assert!(!b.path().join("cli.toml").exists());

    let show_b = cli()
        .args([
            "--data-dir",
            b.path().to_str().unwrap(),
            "--json",
            "config",
            "show",
        ])
        .output()
        .unwrap();
    assert!(show_b.status.success());
    let envelope = parse_envelope(&show_b.stdout);
    // B never ran `config init`, so it resolves to compiled-in defaults —
    // never a value that leaked in from A.
    assert_eq!(envelope["data"]["output_format"]["source"], "cli"); // --json flag itself
    assert_eq!(
        envelope["data"]["default_provider_profile"]["source"],
        "default"
    );
    assert!(envelope["data"]["default_provider_profile"]["value"].is_null());

    // A's own config really did get the profile — confirms the isolation
    // proof above isn't vacuously true because A itself failed silently.
    let app_config: Value =
        serde_json::from_str(&std::fs::read_to_string(a.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(app_config["providers"]["active_id"], profile_id);
}

/// `--data-dir` isolates the *desktop-shared* state; `--app-config` alone
/// (no `--data-dir`) only redirects the `AppConfig` file and must not be
/// reported as an isolated profile — these are two different knobs and the
/// wizard's own report must not conflate them.
#[test]
fn app_config_override_alone_is_not_reported_as_isolated() {
    let home = tempfile::tempdir().unwrap();
    let app_config_path = home.path().join("nested").join("config.json");
    std::fs::create_dir_all(app_config_path.parent().unwrap()).unwrap();

    let output = cli()
        .env("HOME", home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let envelope = parse_envelope(&output.stdout);
    assert!(
        !envelope["data"]["isolated"].as_bool().unwrap(),
        "--app-config alone must not be reported as an isolated profile"
    );
}

/// Configuration precedence (default < global < project < CLI) must stay
/// deterministic when `--data-dir` is in play — isolation changes *where*
/// the global layer lives, never the merge order.
#[test]
fn precedence_stays_deterministic_under_an_isolated_data_dir() {
    let data_dir = tempfile::tempdir().unwrap();
    let project_dir = tempfile::tempdir().unwrap();

    // Global layer (inside the isolated data dir): color = never.
    let init_global = cli()
        .current_dir(project_dir.path())
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--color",
            "never",
            "--skip-provider",
        ])
        .output()
        .unwrap();
    assert!(init_global.status.success());

    // Project layer: color = always.
    let init_project = cli()
        .current_dir(project_dir.path())
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--project",
            "--non-interactive",
            "--color",
            "always",
            "--skip-provider",
        ])
        .output()
        .unwrap();
    assert!(init_project.status.success());

    // No CLI override: project must win over global.
    let show_project_wins = cli()
        .current_dir(project_dir.path())
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "show",
        ])
        .output()
        .unwrap();
    let envelope = parse_envelope(&show_project_wins.stdout);
    assert_eq!(envelope["data"]["color"]["value"], "always");
    assert_eq!(envelope["data"]["color"]["source"], "project");

    // An explicit CLI flag must still win over both.
    let show_cli_wins = cli()
        .current_dir(project_dir.path())
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--color",
            "never",
            "--json",
            "config",
            "show",
        ])
        .output()
        .unwrap();
    let envelope = parse_envelope(&show_cli_wins.stdout);
    assert_eq!(envelope["data"]["color"]["value"], "never");
    assert_eq!(envelope["data"]["color"]["source"], "cli");
}

/// A rejected value (here: an invalid IANA timezone) must fail with a user
/// error before anything is persisted — no partial `AppConfig` or `cli.toml`
/// left behind for a run that never completed. (Credential redaction on a
/// rejected run is proven in-process — see the module doc comment — since
/// exercising this through the compiled binary would require a real
/// `--api-key-*` flag.)
#[test]
fn a_validation_failure_persists_nothing() {
    let data_dir = tempfile::tempdir().unwrap();
    let profile_id = unique_profile_id("rejectedtz", data_dir.path());

    let output = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "openai-compatible",
            "--base-url",
            "http://127.0.0.1:1/v1",
            "--chat-model",
            "test-model",
            "--profile-id",
            &profile_id,
            "--default-timezone",
            "Not/A_Real_Zone",
        ])
        .output()
        .unwrap();

    assert!(!output.status.success());
    let envelope = parse_envelope(&output.stdout);
    assert_eq!(envelope["error"]["kind"], "user_error");
    // Nothing should have been persisted at all — the timezone check runs
    // before either config file is written.
    assert!(!data_dir.path().join("config.json").exists());
    assert!(!data_dir.path().join("cli.toml").exists());
}

/// No `.tmp` file must survive a successful `config init` — both writes go
/// through the existing atomic temp-file-then-rename primitives
/// (`cd_core::config::save_config`, `crate::config::save_layer`), and this
/// proves the new wizard code path actually reaches them rather than
/// writing some other, non-atomic way.
#[test]
fn a_successful_init_leaves_no_tmp_files_behind() {
    let data_dir = tempfile::tempdir().unwrap();
    let profile_id = unique_profile_id("atomic", data_dir.path());

    let output = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "ollama",
            "--chat-model",
            "llama3",
            "--profile-id",
            &profile_id,
        ])
        .output()
        .unwrap();
    assert!(output.status.success());

    assert!(data_dir.path().join("config.json").is_file());
    assert!(data_dir.path().join("cli.toml").is_file());
    for entry in std::fs::read_dir(data_dir.path()).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        assert!(
            !name.ends_with(".tmp"),
            "leftover temp file after a successful init: {name}"
        );
    }

    // Re-running with --force must fully replace, not merge/corrupt, the
    // previous file — proving the rename actually publishes a complete
    // new file rather than something partially written in place.
    let second = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--force",
            "--color",
            "always",
            "--skip-provider",
        ])
        .output()
        .unwrap();
    assert!(second.status.success());
    let cli_toml = std::fs::read_to_string(data_dir.path().join("cli.toml")).unwrap();
    assert!(cli_toml.contains("always"));
    for entry in std::fs::read_dir(data_dir.path()).unwrap() {
        let name = entry.unwrap().file_name();
        assert!(!name.to_string_lossy().ends_with(".tmp"));
    }
}

/// macOS spells its ordinary temporary roots through root-owned aliases
/// (`/tmp` and `/var`). The durable app-config writer must accept the exact
/// caller spelling after verifying that system alias, while continuing to
/// report that spelling and writing nowhere outside the corresponding
/// canonical directory.
#[test]
#[cfg(target_os = "macos")]
fn uncanonicalized_macos_tmp_data_dir_initializes_safely() {
    let canonical_dir = tempfile::Builder::new()
        .prefix("cd-cli-macos-tmp-alias-")
        .tempdir_in("/private/tmp")
        .expect("create canonical macOS tmp fixture");
    let leaf = canonical_dir
        .path()
        .strip_prefix("/private/tmp")
        .expect("fixture beneath /private/tmp");
    let alias_dir = Path::new("/tmp").join(leaf);

    let output = cli()
        .args([
            "--data-dir",
            alias_dir.to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--skip-provider",
            "--default-timezone",
            "America/Chicago",
        ])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "uncanonicalized /tmp data dir must succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope = parse_envelope(&output.stdout);
    assert!(envelope["ok"].as_bool().unwrap());
    assert_eq!(
        envelope["data"]["data_dir"].as_str().unwrap(),
        alias_dir.to_str().unwrap()
    );
    assert!(alias_dir.join("config.json").is_file());
    assert!(alias_dir.join("cli.toml").is_file());
    assert!(canonical_dir.path().join("config.json").is_file());
    assert!(canonical_dir.path().join("cli.toml").is_file());
}

/// A process with no controlling terminal (exactly what `assert_cmd` spawns
/// — and exactly what a script or CI job looks like) must default to
/// non-interactive and terminate on its own, never block waiting for input
/// that will never arrive, even when neither `--interactive` nor
/// `--non-interactive` is passed explicitly.
#[test]
fn non_tty_invocation_defaults_to_non_interactive_and_never_hangs() {
    let data_dir = tempfile::tempdir().unwrap();
    let output = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "must complete without any flag forcing non-interactive mode: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(data_dir.path().join("cli.toml").is_file());
}

/// An explicit `--interactive` wizard, fed answers over piped (non-TTY)
/// stdin, must consume exactly the expected number of lines and terminate
/// — proving the wizard is drivable by a script even when the developer
/// wants the guided prompts rather than flags. Combined with `--json`, this
/// also proves the interactive prompts land on stderr, not stdout: stdout
/// must be nothing but the one parseable JSON envelope, never prompt text
/// prepended to (or interleaved with) it.
#[test]
fn interactive_wizard_completes_over_piped_stdin_and_keeps_stdout_pure_json() {
    let data_dir = tempfile::tempdir().unwrap();
    // Answers, one per prompt: format, color, profile pointer (blank),
    // "configure a provider?" -> no.
    let answers = "json\nauto\n\nn\n";

    let mut cmd = cli();
    cmd.args([
        "--data-dir",
        data_dir.path().to_str().unwrap(),
        "--json",
        "config",
        "init",
        "--interactive",
    ])
    .write_stdin(answers);
    let output = cmd.output().unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    // The whole point: stdout must parse as exactly one JSON envelope, with
    // no prompt text prepended — a prior version of this wizard wrote
    // prompts to stdout, corrupting the --json contract whenever
    // interactive mode combined with --json (including the plain
    // tty-auto-detected case).
    let envelope = parse_envelope(&output.stdout);
    assert!(envelope["ok"].as_bool().unwrap());

    // The prompts must still have gone somewhere the user can see them.
    let stderr_text = String::from_utf8_lossy(&output.stderr);
    assert!(stderr_text.contains("Output format"));
    assert!(stderr_text.contains("Configure an AI provider now?"));

    let cli_toml = std::fs::read_to_string(data_dir.path().join("cli.toml")).unwrap();
    assert!(cli_toml.contains("json"));
    assert!(!data_dir.path().join("config.json").exists());
}

/// `--provider-kind openai-compatible` must parse — a regression guard for
/// clap's default kebab-case rendering, which would otherwise turn
/// `OpenAiCompatible` into `open-ai-compatible` and silently diverge from
/// `cd_core::providers::descriptor_for`'s `openai-compatible` slug and the
/// wizard's own interactive prompt text.
#[test]
fn provider_kind_flag_matches_the_documented_slug() {
    let data_dir = tempfile::tempdir().unwrap();
    let profile_id = unique_profile_id("slug", data_dir.path());
    let output = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "openai-compatible",
            "--base-url",
            "http://127.0.0.1:1/v1",
            "--chat-model",
            "test-model",
            "--profile-id",
            &profile_id,
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The optional connectivity check must run only when explicitly requested,
/// must send no corpus content (it isn't even in scope at `config init`
/// time), and must report a deterministic outcome against an always-closed
/// loopback port — proving the wizard actually invokes the probe rather
/// than only accepting the flag.
#[test]
fn check_connection_probes_and_reports_without_hanging() {
    let data_dir = tempfile::tempdir().unwrap();
    let profile_id = unique_profile_id("probe", data_dir.path());
    let output = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "ollama",
            "--base-url",
            "http://127.0.0.1:1",
            "--chat-model",
            "llama3",
            "--profile-id",
            &profile_id,
            "--check-connection",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope = parse_envelope(&output.stdout);
    let check = envelope["data"]["connectivity_check"]
        .as_str()
        .expect("connectivity_check must be populated when --check-connection is passed");
    assert!(
        check.contains("unreachable"),
        "port 1 is never a real Ollama endpoint: {check}"
    );
}

/// Without `--check-connection` (and outside a terminal, so the wizard
/// cannot prompt for it either), no probe must run at all.
#[test]
fn connectivity_check_is_never_run_unless_requested() {
    let data_dir = tempfile::tempdir().unwrap();
    let profile_id = unique_profile_id("noprobe", data_dir.path());
    let output = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "ollama",
            "--chat-model",
            "llama3",
            "--profile-id",
            &profile_id,
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let envelope = parse_envelope(&output.stdout);
    assert!(envelope["data"]["connectivity_check"].is_null());
}

/// An isolated profile's default (no explicit `--profile-id`) provider
/// profile id must never equal the plain, provider-kind-derived slug the
/// desktop-shared default uses — that slug is also the keychain ref
/// `provider/<slug>/api_key`, so an equal id would mean an isolated,
/// supposedly-throwaway `config init` silently reads and overwrites the
/// same real OS keychain entry a prior non-isolated run (or the desktop
/// app) already used for the same provider kind.
#[test]
fn isolated_default_profile_id_never_equals_the_shared_slug() {
    let data_dir = tempfile::tempdir().unwrap();
    let output = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "anthropic",
            "--chat-model",
            "claude-3",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope = parse_envelope(&output.stdout);
    let id = envelope["data"]["provider_profile_id"]
        .as_str()
        .expect("provider_profile_id must be populated");
    assert_ne!(
        id, "anthropic",
        "an isolated profile must never default to the shared profile's id/keychain entry"
    );
    assert!(
        id.starts_with("anthropic-"),
        "expected a data-dir-scoped suffix on the default id, got {id:?}"
    );
}

/// `--check-connection` for `xai-grok-build` must be refused, not silently
/// run, when the profile is isolated: `cd_core::discovery::probe_provider`
/// reads the real `~/.grok/auth.json` for this kind regardless of any key
/// resolved for the profile, which would otherwise transmit a real, shared
/// session credential from a process the user believed touched nothing but
/// the given `--data-dir`.
#[test]
fn xai_grok_build_check_connection_is_refused_when_isolated() {
    let data_dir = tempfile::tempdir().unwrap();
    let output = cli()
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "xai-grok-build",
            "--chat-model",
            "grok-4",
            "--check-connection",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "must still succeed — the check is skipped, not an error: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let envelope = parse_envelope(&output.stdout);
    let check = envelope["data"]["connectivity_check"]
        .as_str()
        .expect("connectivity_check must still be populated with a skip explanation");
    assert!(
        check.contains("skipped"),
        "an isolated profile must refuse to probe a Grok Build session: {check}"
    );
}
