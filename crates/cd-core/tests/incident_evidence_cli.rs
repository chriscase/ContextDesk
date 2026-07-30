use std::env;
use std::process::Command;

#[cfg(not(windows))]
use cd_core::incident_evidence::validate_directory;
#[cfg(not(windows))]
use std::path::Path;

#[test]
fn incident_evidence_help_is_a_successful_read_only_action() {
    let output = Command::new(env!("CARGO_BIN_EXE_cd-validate-incident-evidence"))
        .arg("--help")
        .output()
        .expect("run incident evidence help");

    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout)
        .contains("cd-validate-incident-evidence validate <directory-or-zip>"));
    assert!(output.stderr.is_empty());
}

#[test]
fn incident_evidence_missing_command_is_a_usage_error() {
    let output = Command::new(env!("CARGO_BIN_EXE_cd-validate-incident-evidence"))
        .output()
        .expect("run incident evidence without arguments");

    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
}

#[cfg(not(windows))]
#[test]
fn python_reference_producer_emits_a_valid_bundle() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/incident-evidence-producers/produce.py");
    let temp = tempfile::tempdir().expect("producer temp dir");
    let output = Command::new("python3")
        .arg(&script)
        .current_dir(temp.path())
        .output()
        .expect("run Python reference producer");

    assert!(
        output.status.success(),
        "producer stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report = validate_directory(&temp.path().join("incident-evidence-out"));
    assert!(report.ok, "{:?}", report.diagnostics);
}
