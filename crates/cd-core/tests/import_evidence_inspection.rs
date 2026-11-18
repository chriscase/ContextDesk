use cd_core::log_analysis::{
    import_evidence::inspect_import_evidence, import_preview::preview_import_plan,
};
use std::{
    io::{Cursor, Write},
    path::Path,
};

const DOCUMENT: &[u8] = b"<!doctype html><html><body><h1>System status</h1><p>password=super-secret-value</p><script>never execute</script></body></html>";
fn inspect(
    path: &Path,
    identity: &str,
) -> cd_core::log_analysis::import_evidence::ImportEvidenceText {
    let plan = preview_import_plan(path, None).unwrap();
    inspect_import_evidence(path, &plan.plan_token, plan.plan_version, identity).unwrap()
}
fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in entries {
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file(*name, options).unwrap();
        writer.write_all(data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
#[test]
fn passive_document_is_redacted_and_plan_bound() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("report.html");
    std::fs::write(&path, DOCUMENT).unwrap();
    let plan = preview_import_plan(&path, None).unwrap();
    let result = inspect(&path, "report.html");
    assert!(result.text.contains("System status"));
    assert!(!result.text.contains("super-secret-value"));
    assert!(!result.text.contains("never execute"));
    assert!(!result.text.contains("<html"));
    assert!(!result.truncated);
    for (version, token, identity) in [
        (
            plan.plan_version + 1,
            plan.plan_token.as_str(),
            "report.html",
        ),
        (plan.plan_version, "forged", "report.html"),
        (
            plan.plan_version,
            plan.plan_token.as_str(),
            "../secret.html",
        ),
    ] {
        assert!(inspect_import_evidence(&path, token, version, identity).is_err());
    }
    let replaced = String::from_utf8(DOCUMENT.to_vec())
        .unwrap()
        .replace("System", "ALTERD");
    std::fs::write(&path, replaced).unwrap();
    assert!(
        inspect_import_evidence(&path, &plan.plan_token, plan.plan_version, "report.html").is_err()
    );
}
#[test]
fn exact_nested_archive_and_directory_identities_are_readable() {
    let temp = tempfile::tempdir().unwrap();
    let nested = zip(&[("report.html", DOCUMENT)]);
    let archive = temp.path().join("bundle.zip");
    std::fs::write(&archive, zip(&[("nested.zip", &nested)])).unwrap();
    let result = inspect(&archive, "nested.zip!/report.html");
    assert!(result.text.contains("System status"));
    let result = inspect(temp.path(), "bundle.zip!/nested.zip!/report.html");
    assert!(result.text.contains("System status"));
    let plain = temp.path().join("ordinary.html");
    std::fs::write(&plain, DOCUMENT).unwrap();
    assert!(inspect(temp.path(), "ordinary.html")
        .text
        .contains("System status"));
}
#[test]
fn event_sources_and_archive_traversal_are_refused() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("events.html");
    std::fs::write(
        &path,
        include_bytes!("../../../fixtures/import-html/pre.html"),
    )
    .unwrap();
    let plan = preview_import_plan(&path, None).unwrap();
    assert!(
        inspect_import_evidence(&path, &plan.plan_token, plan.plan_version, "events.html").is_err()
    );
    let path = temp.path().join("hostile.zip");
    std::fs::write(&path, zip(&[("../secret.html", DOCUMENT)])).unwrap();
    assert!(inspect_import_evidence(&path, &"0".repeat(64), 1, "../secret.html").is_err());
}
#[test]
fn long_document_discloses_visible_text_truncation() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("long.html");
    std::fs::write(
        &path,
        format!(
            "<html><body><p>{}</p></body></html>",
            "status ".repeat(1800)
        ),
    )
    .unwrap();
    let result = inspect(&path, "long.html");
    assert!(result.truncated);
    assert!(result.text.len() <= 8192);
}
#[cfg(unix)]
#[test]
fn symlink_replacement_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("report.html");
    let other = temp.path().join("other.html");
    std::fs::write(&path, DOCUMENT).unwrap();
    std::fs::write(&other, DOCUMENT).unwrap();
    let plan = preview_import_plan(&path, None).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&other, &path).unwrap();
    assert!(
        inspect_import_evidence(&path, &plan.plan_token, plan.plan_version, "report.html").is_err()
    );
}
