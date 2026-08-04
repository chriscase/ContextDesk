//! Adversarial acceptance for the import preview traversal.
//!
//! The unit tests in `log_analysis::import_preview` cover classification with
//! synthetic samples. These cover the parts only a real filesystem and a real
//! ZIP can exercise: traversal refusals, identity collisions, nested archives,
//! cancellation, and — most importantly — that a preview report never carries
//! raw payload, credentials, or host paths off the machine.
//!
//! Every test asserts the *preview* behaves like the import path it previews.
//! Where the two could drift, that drift is the bug being hunted.

use std::io::Write;
use std::path::Path;

use cd_core::log_analysis::import_preview::{
    event_importable, preview_import_path, ImportItemRole, ImportItemStatus, ImportPreviewReason,
    ImportSourceKind,
};
use cd_core::process_progress::CancelFlag;

/// Minimal stored-entry ZIP writer so tests control the exact bytes.
fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (name, body) in entries {
            writer.start_file(*name, options).expect("start entry");
            writer.write_all(body).expect("write entry");
        }
        writer.finish().expect("finish zip");
    }
    cursor.into_inner()
}

fn write(path: &Path, body: &[u8]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(path, body).expect("write file");
}

const JSON_LINE: &str = r#"{"ts":"2026-01-01T00:00:00Z","level":"info","msg":"ready"}"#;

#[test]
fn preview_never_creates_anything_under_the_source() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(&dir.path().join("app.jsonl"), JSON_LINE.as_bytes());

    let before = std::fs::read_dir(dir.path())
        .expect("read")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect::<std::collections::BTreeSet<_>>();

    let report = preview_import_path(dir.path(), None).expect("preview");
    assert_eq!(report.counts.total, 1);

    let after = std::fs::read_dir(dir.path())
        .expect("read")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(before, after, "preview must not write to the source tree");
}

#[test]
fn directly_selected_symlink_is_refused_exactly_like_ingest() {
    #[cfg(unix)]
    {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("real.log");
        write(&target, JSON_LINE.as_bytes());
        let link = dir.path().join("link.log");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");

        let error = preview_import_path(&link, None).expect_err("must refuse");
        assert!(
            error.to_string().contains("symlink"),
            "unexpected error: {error}"
        );
    }
}

#[test]
fn symlinks_inside_a_directory_are_blocked_and_visible_not_dropped() {
    #[cfg(unix)]
    {
        let dir = tempfile::tempdir().expect("tempdir");
        write(&dir.path().join("real.jsonl"), JSON_LINE.as_bytes());
        // Escapes the selected root entirely.
        std::os::unix::fs::symlink("/etc/passwd", dir.path().join("escape.log")).expect("symlink");

        let report = preview_import_path(dir.path(), None).expect("preview");
        let escape = report
            .items
            .iter()
            .find(|item| item.identity == "escape.log")
            .expect("the refused entry must still be listed, not silently dropped");
        assert_eq!(escape.status, ImportItemStatus::Blocked);
        assert_eq!(
            escape.reasons,
            vec![ImportPreviewReason::SymlinkRejected],
            "a blocked symlink must say why"
        );
        assert!(!escape.selected);
        assert!(!report.selected_identities().contains(&"escape.log"));
    }
}

#[test]
fn duplicate_basenames_stay_distinct_through_relative_identity() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(&dir.path().join("a/app.jsonl"), JSON_LINE.as_bytes());
    write(&dir.path().join("b/app.jsonl"), JSON_LINE.as_bytes());

    let report = preview_import_path(dir.path(), None).expect("preview");
    let identities: Vec<&str> = report.items.iter().map(|i| i.identity.as_str()).collect();
    assert_eq!(identities, vec!["a/app.jsonl", "b/app.jsonl"]);
    assert_eq!(report.counts.ready, 2);
    // Both display the same redacted leaf; identity is what disambiguates.
    assert!(report.items.iter().all(|item| item.basename == "app.jsonl"));
}

#[test]
fn nested_archives_are_recursed_with_chained_virtual_identities() {
    let dir = tempfile::tempdir().expect("tempdir");
    let inner = zip_bytes(&[("deep/inner.jsonl", JSON_LINE.as_bytes())]);
    let outer = zip_bytes(&[
        ("top.jsonl", JSON_LINE.as_bytes()),
        ("nested.zip", inner.as_slice()),
    ]);
    write(&dir.path().join("bundle.zip"), &outer);

    let report = preview_import_path(dir.path(), None).expect("preview");
    let identities: Vec<&str> = report.items.iter().map(|i| i.identity.as_str()).collect();

    assert!(
        identities.contains(&"bundle.zip!/top.jsonl"),
        "archive members use the archive!/member identity: {identities:?}"
    );
    // The real import descends into a nested archive, so the preview must too.
    // An earlier version stopped at the container and under-reported every
    // bundle-in-bundle, which made plan_block() refuse imports that succeed.
    assert!(
        identities.contains(&"bundle.zip!/nested.zip!/deep/inner.jsonl"),
        "nested archives must be recursed with chained identities: {identities:?}"
    );
    assert!(report.counts.ready >= 2);
    assert_eq!(report.plan_block(), None);
}

#[test]
fn a_directly_selected_zip_previews_members_with_bare_identities() {
    let dir = tempfile::tempdir().expect("tempdir");
    let archive = dir.path().join("outer.zip");
    write(
        &archive,
        &zip_bytes(&[("visible.jsonl", JSON_LINE.as_bytes())]),
    );

    let report = preview_import_path(&archive, None).expect("preview");
    assert_eq!(report.source_kind, ImportSourceKind::Archive);
    // Matches ingest's `prefix_members = false` for a directly selected zip.
    assert_eq!(
        report
            .items
            .iter()
            .map(|i| i.identity.as_str())
            .collect::<Vec<_>>(),
        vec!["visible.jsonl"]
    );
}

#[test]
fn xml_capability_gate_has_folder_zip_parity_and_keeps_real_logs_selected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let folder = dir.path().join("source-folder");
    std::fs::create_dir_all(&folder).expect("create folder");

    let report_xml = b"<report><summary status=\"ok\"/></report>";
    let repeated_xml =
        b"<events><event level=\"info\">started</event><event level=\"warn\">slow</event></events>";
    let disguised_xml = b"<?xml version=\"1.0\"?><settings><enabled>true</enabled></settings>";
    write(&folder.join("diagnostic-report.xml"), report_xml);
    write(&folder.join("structured-feed.xml"), repeated_xml);
    write(&folder.join("settings-document.txt"), disguised_xml);
    write(&folder.join("events.jsonl"), JSON_LINE.as_bytes());

    let archive = dir.path().join("source-archive.zip");
    write(
        &archive,
        &zip_bytes(&[
            ("diagnostic-report.xml", report_xml),
            ("structured-feed.xml", repeated_xml),
            ("settings-document.txt", disguised_xml),
            ("events.jsonl", JSON_LINE.as_bytes()),
        ]),
    );

    let folder_report = preview_import_path(&folder, None).expect("folder preview");
    let zip_report = preview_import_path(&archive, None).expect("zip preview");

    for report in [&folder_report, &zip_report] {
        assert_eq!(report.selected_identities(), vec!["events.jsonl"]);
        for identity in [
            "diagnostic-report.xml",
            "settings-document.txt",
            "structured-feed.xml",
        ] {
            let item = report
                .items
                .iter()
                .find(|item| item.identity == identity)
                .expect("XML-shaped item stays visible");
            assert_eq!(item.status, ImportItemStatus::Supporting);
            assert_eq!(item.role, ImportItemRole::Attachment);
            assert!(!item.selected);
            assert!(!event_importable(item));
            assert_eq!(
                item.reasons,
                vec![ImportPreviewReason::XmlEventParsingUnsupported]
            );
        }

        let json = report
            .items
            .iter()
            .find(|item| item.identity == "events.jsonl")
            .expect("structured log remains visible");
        assert_eq!(json.status, ImportItemStatus::Ready);
        assert_eq!(json.role, ImportItemRole::Log);
        assert!(json.selected);
        assert!(event_importable(json));
    }

    let folder_facts: Vec<_> = folder_report
        .items
        .iter()
        .map(|item| {
            (
                item.identity.as_str(),
                item.status,
                item.role,
                item.selected,
                item.reasons.as_slice(),
            )
        })
        .collect();
    let zip_facts: Vec<_> = zip_report
        .items
        .iter()
        .map(|item| {
            (
                item.identity.as_str(),
                item.status,
                item.role,
                item.selected,
                item.reasons.as_slice(),
            )
        })
        .collect();
    assert_eq!(folder_facts, zip_facts, "transport must not change routing");
}

#[test]
fn content_decides_archive_detection_not_the_extension() {
    let dir = tempfile::tempdir().expect("tempdir");
    // A ZIP wearing a .log extension.
    write(
        &dir.path().join("masquerade.log"),
        &zip_bytes(&[("hidden.jsonl", JSON_LINE.as_bytes())]),
    );

    let report = preview_import_path(dir.path(), None).expect("preview");
    let identities: Vec<&str> = report.items.iter().map(|i| i.identity.as_str()).collect();
    assert!(
        identities.contains(&"masquerade.log!/hidden.jsonl"),
        "a ZIP named .log must still be treated as an archive: {identities:?}"
    );
}

#[test]
fn a_text_file_named_zip_fails_exactly_like_ingest() {
    // Archive detection must agree with ingest, which for a directory member
    // is `has_zip_extension(file) || has_zip_signature(..)`. A `.zip` name over
    // plain text therefore enters the archive path and fails preflight — in
    // BOTH paths. An earlier preview used the signature alone and cheerfully
    // reported this file as a ready-to-import JSON source, while the real
    // import aborted the whole directory.
    let dir = tempfile::tempdir().expect("tempdir");
    write(&dir.path().join("not-really.zip"), JSON_LINE.as_bytes());

    let preview_error = preview_import_path(dir.path(), None)
        .expect_err("preview must fail where the import fails");

    let cache = tempfile::tempdir().expect("cache");
    let ingest_error = cd_core::log_analysis::ingest::ingest_path(
        cache.path(),
        dir.path(),
        "parity",
        None,
        "test-model",
    )
    .expect_err("ingest must fail too");

    assert_eq!(
        preview_error.to_string(),
        ingest_error.to_string(),
        "preview must predict the import's failure, not contradict it"
    );
}

#[test]
fn binary_content_under_a_log_name_is_unsupported_and_never_selected() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend_from_slice(&[0u8; 512]);
    write(&dir.path().join("looks-like.log"), &png);

    let report = preview_import_path(dir.path(), None).expect("preview");
    let item = &report.items[0];
    assert_eq!(item.status, ImportItemStatus::Unsupported);
    assert!(item.reasons.contains(&ImportPreviewReason::BinaryContent));
    assert!(!item.selected);
    assert_eq!(report.counts.selected, 0);
}

#[test]
fn empty_files_are_reported_rather_than_skipped() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(&dir.path().join("empty.log"), b"");

    let report = preview_import_path(dir.path(), None).expect("preview");
    let item = &report.items[0];
    assert_eq!(item.status, ImportItemStatus::Unsupported);
    assert!(item.reasons.contains(&ImportPreviewReason::EmptyContent));
    assert_eq!(report.counts.total, 1, "an empty file is still inventoried");
}

#[test]
fn mixed_format_file_is_not_locked_in_by_its_first_window() {
    let dir = tempfile::tempdir().expect("tempdir");
    // A JSON head, then a very large plain-text body. Head-only sampling
    // would call this JSON; head+interior+tail must not.
    let mut body = String::new();
    body.push_str(JSON_LINE);
    body.push('\n');
    for index in 0..40_000 {
        body.push_str(&format!("plain unstructured line {index}\n"));
    }
    write(&dir.path().join("mixed.log"), body.as_bytes());

    let report = preview_import_path(dir.path(), None).expect("preview");
    let item = &report.items[0];
    assert_ne!(
        item.status,
        ImportItemStatus::Ready,
        "first-window lock-in: a mostly-plain file must not be reported as a strong match"
    );
    assert!(
        item.selected,
        "a reviewable event-bearing text source must remain selected even when it is not a strong structured match"
    );
}

#[test]
fn cancellation_stops_the_preview_and_leaves_nothing_behind() {
    let dir = tempfile::tempdir().expect("tempdir");
    for index in 0..64 {
        write(
            &dir.path().join(format!("app-{index}.jsonl")),
            JSON_LINE.as_bytes(),
        );
    }
    let before = std::fs::read_dir(dir.path()).expect("read").count();

    let cancel = CancelFlag::new();
    cancel.cancel();
    let error = preview_import_path(dir.path(), Some(&cancel)).expect_err("must cancel");
    assert!(
        matches!(error, cd_core::error::CoreError::Cancelled),
        "unexpected error: {error}"
    );

    let after = std::fs::read_dir(dir.path()).expect("read").count();
    assert_eq!(before, after, "cancellation must not disturb the source");
}

#[test]
fn hidden_entries_are_supporting_and_not_preselected() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(&dir.path().join("app.jsonl"), JSON_LINE.as_bytes());
    write(&dir.path().join(".hidden.jsonl"), JSON_LINE.as_bytes());

    let report = preview_import_path(dir.path(), None).expect("preview");
    let hidden = report
        .items
        .iter()
        .find(|item| item.identity == ".hidden.jsonl")
        .expect("hidden entries must appear in the ledger, not vanish from it");
    assert_eq!(hidden.status, ImportItemStatus::Ignored);
    assert_eq!(report.counts.ignored, 1);
    assert!(
        !hidden.selected,
        "hidden files must not be silently imported"
    );
    assert!(report.selected_identities().contains(&"app.jsonl"));
}

#[test]
fn rolled_files_group_only_when_content_agrees() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(&dir.path().join("app.jsonl.1"), JSON_LINE.as_bytes());
    write(&dir.path().join("app.jsonl.2"), JSON_LINE.as_bytes());

    let report = preview_import_path(dir.path(), None).expect("preview");
    assert_eq!(report.groups.len(), 1, "agreeing rolled files group");
    assert_eq!(report.groups[0].member_identities.len(), 2);
    assert!(
        report.groups[0].possible_overlap,
        "rotation overlap must be disclosed, not assumed away"
    );
    // Grouping never removes a member's own row.
    assert_eq!(report.counts.total, 2);

    let other = tempfile::tempdir().expect("tempdir");
    write(&other.path().join("app.jsonl.1"), JSON_LINE.as_bytes());
    write(
        &other.path().join("app.jsonl.2"),
        b"<34>1 2026-01-01T00:00:00Z host app - - - boot\n",
    );
    let report = preview_import_path(other.path(), None).expect("preview");
    assert!(
        report.groups.is_empty(),
        "a shared rolled stem must never group sources whose content disagrees"
    );
}

#[test]
fn report_carries_no_absolute_paths_credentials_or_raw_payload() {
    let dir = tempfile::tempdir().expect("tempdir");
    let secret = "AKIAIOSFODNN7EXAMPLE";
    write(
        &dir.path().join("creds.log"),
        format!("2026-01-01 INFO aws_access_key_id={secret} boot\n").as_bytes(),
    );
    write(
        &dir.path().join("app.jsonl"),
        b"{\"ts\":\"2026-01-01T00:00:00Z\",\"aws_access_key_id\":\"AKIAIOSFODNN7EXAMPLE\"}\n",
    );

    let report = preview_import_path(dir.path(), None).expect("preview");
    let encoded = serde_json::to_string(&report).expect("serialize");

    assert!(
        !encoded.contains(secret),
        "a preview report is model-facing context; credentials must never survive it"
    );
    assert!(!encoded.contains(secret));
    assert!(
        !encoded.contains(dir.path().to_string_lossy().as_ref()),
        "absolute host paths must not appear in a preview report"
    );
    assert!(!encoded.contains("/var/folders/"));
    assert!(!encoded.contains("/Users/"));
}

#[test]
fn preview_and_ingest_agree_on_which_sources_are_importable() {
    // The whole point of previewing is that it predicts the real import.
    let dir = tempfile::tempdir().expect("tempdir");
    write(&dir.path().join("good.jsonl"), JSON_LINE.as_bytes());
    write(&dir.path().join("binary.log"), &[0u8; 256]);
    write(&dir.path().join("empty.log"), b"");

    let report = preview_import_path(dir.path(), None).expect("preview");

    let cache = tempfile::tempdir().expect("cache");
    let ingested = cd_core::log_analysis::ingest::ingest_path(
        cache.path(),
        dir.path(),
        "agreement",
        None,
        "test-model",
    )
    .expect("ingest");

    // Preview said exactly one source is a strong, importable match.
    assert_eq!(report.counts.ready, 1);
    assert_eq!(report.selected_identities(), vec!["good.jsonl"]);
    // Ingest agrees that only one file carried events.
    assert_eq!(
        ingested.stats.files, 1,
        "preview must predict the real import, not merely describe the directory"
    );
    assert!(ingested.stats.lines >= 1);
}

#[test]
fn a_hidden_archive_member_is_ignored_noise_like_a_hidden_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(
        &dir.path().join("bundle.zip"),
        &zip_bytes(&[
            (".hidden.jsonl", JSON_LINE.as_bytes()),
            ("real.jsonl", JSON_LINE.as_bytes()),
        ]),
    );

    let report = preview_import_path(dir.path(), None).expect("preview");
    let hidden = report
        .items
        .iter()
        .find(|item| item.identity.ends_with(".hidden.jsonl"))
        .expect("hidden member listed");
    assert_eq!(
        hidden.status,
        ImportItemStatus::Ignored,
        "the same condition on disk and in an archive must land in the same ledger state"
    );
    assert!(report.counts.ignored >= 1);
}

#[test]
fn archive_members_are_sampled_across_head_interior_and_tail() {
    // A ZIP entry is a streaming reader, so an earlier version buffered only
    // the head and "sampled" three windows out of that one region — restoring
    // first-window lock-in inside archives. A JSON first line over a large
    // plain body must not read as a strong JSON match.
    let dir = tempfile::tempdir().expect("tempdir");
    let mut body = String::new();
    body.push_str(JSON_LINE);
    body.push('\n');
    for index in 0..40_000 {
        body.push_str(&format!("plain unstructured line {index}\n"));
    }
    write(
        &dir.path().join("bundle.zip"),
        &zip_bytes(&[("mixed.log", body.as_bytes())]),
    );

    let report = preview_import_path(dir.path(), None).expect("preview");
    let item = report
        .items
        .iter()
        .find(|item| item.identity.ends_with("mixed.log"))
        .expect("member listed");
    assert_ne!(
        item.status,
        ImportItemStatus::Ready,
        "a mostly-plain archive member must not be reported as a strong match"
    );
    assert!(
        item.selected,
        "archive transport must not deselect a reviewable event-bearing text source"
    );
}

#[test]
fn a_hidden_subtree_is_reported_rather_than_vanishing() {
    let dir = tempfile::tempdir().expect("tempdir");
    write(&dir.path().join("app.jsonl"), JSON_LINE.as_bytes());
    write(&dir.path().join(".git/config"), b"[core]\n");

    let report = preview_import_path(dir.path(), None).expect("preview");
    assert!(
        report.counts.ignored >= 1,
        "a hidden subtree must appear in the ledger: {:?}",
        report
            .items
            .iter()
            .map(|i| (&i.identity, i.status))
            .collect::<Vec<_>>()
    );
    assert!(report.selected_identities().contains(&"app.jsonl"));
}
