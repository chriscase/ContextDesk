use std::process::Command;

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
