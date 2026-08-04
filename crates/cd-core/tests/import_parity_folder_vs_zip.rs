//! Desktop-host import acceptance: the SAME logical corpus must import
//! identically whether the operator picks a folder or a ZIP.
//!
//! These drive the exact `cd-core` entry points the Tauri commands behind
//! LogPane call — `log_preview_import` → [`preview_import_plan`],
//! `log_run_import` → [`verify_import_plan`] + selection-bound ingest, and
//! quick import → `ingest_path_with_policy_and_observer`. They are
//! not reducer tests: every assertion is on what the trusted core actually
//! produced from bytes on disk.
//!
//! Every fixture is independently authored, generic, synthetic data. No
//! archive, filename, or content from any real system appears here.
//!
//! # The property under test
//!
//! Transport is not supposed to be semantics. A folder and a ZIP holding
//! byte-identical members must yield the same discovered/selectable/selected
//! identities, the same imported events, the same per-source catalog counts,
//! the same unresolved-local-timezone sources, source catalog, and post-apply
//! revision.

use cd_core::log_analysis::import_preview::{
    event_importable, preview_import_plan, verify_import_plan,
};
use cd_core::log_analysis::ingest::{
    ingest_path_with_policy_and_observer, ingest_path_with_policy_selection_and_observer,
};
use cd_core::log_analysis::store::LogCorpus;
use cd_core::log_analysis::{
    apply_source_timezones, load_timezone_resolution_state, preview_source_timezone,
    query_source_catalog, LogEmbedPolicy, LogSourceCatalogQuery, SourceTimezoneApplyRequest,
};
use cd_core::process_progress::NoopProcessProgress;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The streaming chunk `import_preview::sample_streaming` reads a
/// non-seekable (archive) member with. The straddling fixture is built
/// against this so one multibyte code point lands across the boundary.
const STREAM_CHUNK_BYTES: usize = 8 * 1024;

// ---------------------------------------------------------------------
// Independently authored synthetic corpus
// ---------------------------------------------------------------------

/// A local wall-clock line with **no zone** — the shape that makes a source
/// report unresolved-local time, so timezone review has something to act on.
fn local_line(seq: usize) -> String {
    format!(
        "2024-03-05 02:{:02}:{:02},654 INFO [com.example.service] (worker-{}) synthetic record seq={seq}\n",
        seq / 60 % 60,
        seq % 60,
        seq % 4
    )
}

/// An RFC 3339 line that carries its own offset — resolved wall-clock time.
fn zoned_line(seq: usize) -> String {
    format!(
        "2024-03-05T12:{:02}:{:02}Z INFO com.example.store synthetic record seq={seq} status=ok\n",
        seq / 60 % 60,
        seq % 60
    )
}

/// A rotated primary log whose bytes place one 3-byte UTF-8 code point
/// exactly across [`STREAM_CHUNK_BYTES`]: one byte in the first streamed
/// chunk, two in the second.
///
/// Everything here is ordinary text. There is no NUL and no invalid byte —
/// the file is valid UTF-8 end to end, which is the whole point.
fn rotated_primary_log() -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut seq = 0usize;
    // The final line before the boundary is padded by hand, so reserve room
    // for its prefix before emitting whole lines.
    let prefix = "2024-03-05 02:59:59,654 INFO [com.example.service] (worker-0) currency ";
    let reserve = STREAM_CHUNK_BYTES - 1 - prefix.len();
    while out.len() + local_line(seq).len() < reserve {
        out.extend_from_slice(local_line(seq).as_bytes());
        seq += 1;
    }
    // One more line, padded so the multibyte char starts at exactly
    // STREAM_CHUNK_BYTES - 1.
    out.extend_from_slice(prefix.as_bytes());
    while out.len() < STREAM_CHUNK_BYTES - 1 {
        out.push(b'x');
    }
    assert_eq!(
        out.len(),
        STREAM_CHUNK_BYTES - 1,
        "fixture must place the code point across the chunk boundary"
    );
    // U+20AC EURO SIGN: 3 bytes. One lands in chunk 0, two in chunk 1.
    out.extend_from_slice("\u{20ac}".as_bytes());
    out.extend_from_slice(b" symbol spans the streaming boundary\n");
    for s in seq..seq + 400 {
        out.extend_from_slice(local_line(s).as_bytes());
    }
    assert!(
        std::str::from_utf8(&out).is_ok(),
        "the fixture is valid UTF-8 end to end; nothing about it is binary"
    );
    out
}

/// A second rotated source, zoned and free of any boundary hazard.
fn rotated_secondary_log() -> Vec<u8> {
    (0..500).map(zoned_line).collect::<String>().into_bytes()
}

/// Producer-neutral local calendar records without logger/thread fields.
/// These must still enter timezone review rather than falling back to plain
/// order-only text with the timestamp embedded in the message.
fn generic_local_log() -> Vec<u8> {
    [
        "2024-03-05 02:10:00,123 INFO  - service initialized\n",
        "2024-03-05 02:10:01 DEBUG cache warmed\n",
        "2024-03-05 02:10:02  APP_INFO-0003: configuration loaded\n",
    ]
    .concat()
    .into_bytes()
}

/// The control: genuinely not text. A NUL plus a dominant run of invalid
/// bytes must stay unsupported in BOTH transports — the parity fix must not
/// be a blanket "treat everything as text".
fn binary_control() -> Vec<u8> {
    let mut out = vec![0u8, 1, 2, 3];
    for byte in 0xF8u8..=0xFF {
        for _ in 0..600 {
            out.push(byte);
        }
    }
    out
}

const PRIMARY: &str = "service.log-20240305T025959Z";
const SECONDARY: &str = "database-20240305T120000Z.log";
const GENERIC_LOCAL: &str = "local-application.log";
const CONTROL: &str = "opaque_payload.bin";

fn corpus_members() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        (PRIMARY, rotated_primary_log()),
        (SECONDARY, rotated_secondary_log()),
        (GENERIC_LOCAL, generic_local_log()),
        (CONTROL, binary_control()),
    ]
}

fn write_folder(root: &Path, members: &[(&'static str, Vec<u8>)]) -> PathBuf {
    let folder = root.join("corpus_folder");
    std::fs::create_dir_all(&folder).expect("create folder");
    for (name, bytes) in members {
        std::fs::write(folder.join(name), bytes).expect("write member");
    }
    folder
}

fn write_zip(
    root: &Path,
    members: &[(&'static str, Vec<u8>)],
    method: zip::CompressionMethod,
    label: &str,
) -> PathBuf {
    let path = root.join(format!("corpus_{label}.zip"));
    let file = std::fs::File::create(&path).expect("create zip");
    let mut zip = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(method);
    for (name, bytes) in members {
        zip.start_file(*name, options).expect("start member");
        zip.write_all(bytes).expect("write member");
    }
    zip.finish().expect("finish zip");
    path
}

// ---------------------------------------------------------------------
// Observations, in the same shape for either transport
// ---------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
struct PreviewFacts {
    /// Every discovered identity, sorted.
    discovered: Vec<String>,
    /// Identities the core says may import as events at all.
    selectable: Vec<String>,
    /// Identities deterministic preselection chose.
    selected: Vec<String>,
    /// `identity -> declared bytes`.
    bytes: Vec<(String, u64)>,
}

fn preview_facts(path: &Path) -> PreviewFacts {
    let plan = preview_import_plan(path, None).expect("preview succeeds");
    let mut discovered: Vec<String> = plan
        .report
        .items
        .iter()
        .map(|item| item.identity.clone())
        .collect();
    let mut selectable: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| event_importable(item))
        .map(|item| item.identity.clone())
        .collect();
    let mut selected: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| item.selected)
        .map(|item| item.identity.clone())
        .collect();
    let mut bytes: Vec<(String, u64)> = plan
        .report
        .items
        .iter()
        .map(|item| (item.identity.clone(), item.bytes))
        .collect();
    discovered.sort();
    selectable.sort();
    selected.sort();
    bytes.sort();
    PreviewFacts {
        discovered,
        selectable,
        selected,
        bytes,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ImportFacts {
    files: usize,
    lines: u64,
    /// `source -> lines`, the per-source catalog the Explorer shows.
    per_source: Vec<(String, u64)>,
    /// Sources whose timestamps are local with no resolvable zone — what
    /// timezone review exists to fix.
    unresolved_local: Vec<String>,
    /// Corpus revision after the import is applied.
    revision: u64,
    /// The durable source catalog the Explorer reads after timezone apply.
    source_catalog: Vec<(String, u64)>,
    /// Number of local records resolved by the reviewed common timezone.
    resolved_local_records: u64,
    /// Exclusion reasons, so a silently dropped source cannot hide.
    exclusions: Vec<(String, u64)>,
}

fn import_facts(cache: &Path, path: &Path, name: &str, reviewed: bool) -> ImportFacts {
    let selection = reviewed.then(|| {
        let plan = preview_import_plan(path, None).expect("preview succeeds");
        let selected: Vec<String> = plan
            .report
            .items
            .iter()
            .filter(|item| item.selected)
            .map(|item| item.identity.clone())
            .collect();
        verify_import_plan(path, plan.plan_version, &plan.plan_token, &selected, None)
            .expect("plan verifies")
    });
    let report = if let Some(selection) = selection.as_ref() {
        ingest_path_with_policy_selection_and_observer(
            cache,
            path,
            name,
            &LogEmbedPolicy::default(),
            None,
            &NoopProcessProgress,
            None,
            selection,
        )
    } else {
        ingest_path_with_policy_and_observer(
            cache,
            path,
            name,
            &LogEmbedPolicy::default(),
            None,
            &NoopProcessProgress,
            None,
        )
    }
    .expect("ingest succeeds");

    let mut per_source: Vec<(String, u64)> = report
        .confidence
        .sources
        .iter()
        .map(|source| (source.source.clone(), source.lines))
        .collect();
    per_source.sort();
    let mut unresolved_local: Vec<String> = report
        .confidence
        .sources
        .iter()
        .filter(|source| !source.unresolved_reasons.is_empty())
        .map(|source| source.source.clone())
        .collect();
    unresolved_local.sort();
    let mut exclusions: Vec<(String, u64)> = report
        .stats
        .exclusion_counts
        .iter()
        .map(|(reason, count)| (reason.clone(), *count))
        .collect();
    exclusions.sort();
    let state = load_timezone_resolution_state(cache, &report.corpus_id)
        .expect("load timezone resolution state");
    let requests: Vec<_> = state
        .sources
        .iter()
        .filter(|source| source.unresolved_local_records > 0)
        .map(|source| {
            let preview = preview_source_timezone(
                cache,
                &report.corpus_id,
                state.scope.event_revision,
                &source.source,
                "UTC",
            )
            .expect("preview common timezone");
            SourceTimezoneApplyRequest {
                source: source.source.clone(),
                iana_timezone: "UTC".into(),
                preview_token: preview.declaration_fingerprint,
            }
        })
        .collect();
    assert!(
        !requests.is_empty(),
        "fixture must exercise timezone review"
    );
    let applied = apply_source_timezones(
        cache,
        &report.corpus_id,
        state.scope.event_revision,
        &requests,
        1_700_000_000,
    )
    .expect("apply reviewed common timezone atomically");
    let post_apply = load_timezone_resolution_state(cache, &report.corpus_id)
        .expect("reload timezone resolution state");
    let resolved_local_records = post_apply
        .sources
        .iter()
        .map(|source| source.resolved_local_records)
        .sum();
    assert!(
        post_apply
            .sources
            .iter()
            .all(|source| source.unresolved_local_records == 0),
        "reviewed common timezone must resolve every local record"
    );

    let corpus = LogCorpus::open(cache, &report.corpus_id).expect("open revised corpus");
    let source_page = query_source_catalog(
        &corpus,
        &LogSourceCatalogQuery {
            search: None,
            cursor: None,
            limit: 100,
        },
    )
    .expect("query Explorer source catalog");
    assert_eq!(
        source_page.sources.len() as u64,
        source_page.total_matched,
        "synthetic source catalog must fit in one bounded page"
    );
    let source_catalog = source_page
        .sources
        .into_iter()
        .map(|source| (source.source, source.event_count))
        .collect();
    ImportFacts {
        files: report.stats.files,
        lines: report.stats.lines,
        per_source,
        unresolved_local,
        revision: applied.revision,
        source_catalog,
        resolved_local_records,
        exclusions,
    }
}

// ---------------------------------------------------------------------
// Standard quick import — parity holds today
// ---------------------------------------------------------------------

/// Quick import (no reviewed selection) must produce the same corpus from a
/// folder and from a ZIP.
///
/// This passes today, and it is what makes the reviewed-path failure below
/// meaningful rather than a broken harness: the same fixture, the same
/// assertions, one transport apart.
#[test]
fn quick_import_preserves_folder_and_zip_parity() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let members = corpus_members();
    let folder = write_folder(tmp.path(), &members);
    let zip = write_zip(
        tmp.path(),
        &members,
        zip::CompressionMethod::Deflated,
        "deflated",
    );

    let folder_cache = tmp.path().join("cache_folder");
    let zip_cache = tmp.path().join("cache_zip");
    let from_folder = import_facts(&folder_cache, &folder, "parity-folder", false);
    let from_zip = import_facts(&zip_cache, &zip, "parity-zip", false);

    assert_eq!(
        from_folder, from_zip,
        "quick import must not depend on transport"
    );

    // Non-vacuous: the corpus really did import every text source, the
    // binary control really was excluded, and timezone review really has
    // something to act on.
    assert_eq!(from_folder.files, 3, "every text source imported");
    assert!(from_folder.lines > 900, "a large corpus, not a stub");
    assert_eq!(
        from_folder.unresolved_local,
        vec![GENERIC_LOCAL.to_string(), PRIMARY.to_string()],
        "both specialized and producer-neutral local timestamps need a timezone"
    );
    assert!(
        from_folder
            .per_source
            .iter()
            .any(|(source, _)| source == SECONDARY),
        "the zoned source is catalogued too"
    );
}

// ---------------------------------------------------------------------
// Reviewed ImportFlow
// ---------------------------------------------------------------------

/// A reviewed import must select
/// and import the same sources from a folder and a ZIP.
#[test]
fn reviewed_import_preserves_folder_and_zip_parity() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let members = corpus_members();
    let folder = write_folder(tmp.path(), &members);
    let zip = write_zip(
        tmp.path(),
        &members,
        zip::CompressionMethod::Deflated,
        "deflated",
    );

    let folder_preview = preview_facts(&folder);
    let zip_preview = preview_facts(&zip);
    assert_eq!(
        folder_preview, zip_preview,
        "discovered / selectable / selected identities and declared bytes \
         must not depend on transport"
    );
    for (label, facts) in [("folder", &folder_preview), ("zip", &zip_preview)] {
        assert_eq!(
            facts.selected,
            vec![
                SECONDARY.to_string(),
                GENERIC_LOCAL.to_string(),
                PRIMARY.to_string(),
            ],
            "{label}: every honest rotated text source must be preselected, \
             while the binary control remains excluded"
        );
    }

    let folder_cache = tmp.path().join("cache_folder");
    let zip_cache = tmp.path().join("cache_zip");
    assert_eq!(
        import_facts(&folder_cache, &folder, "reviewed-folder", true),
        import_facts(&zip_cache, &zip, "reviewed-zip", true),
        "a reviewed import must yield the same events, per-source catalog, \
         unresolved-timezone sources, and revision from either transport"
    );
}

// ---------------------------------------------------------------------
// Control — the fix must not make everything text
// ---------------------------------------------------------------------

/// A genuinely binary member stays unsupported in BOTH transports. Whatever
/// repairs the straddling case must not do it by weakening binary
/// detection.
#[test]
fn a_real_binary_control_stays_unsupported_in_both_transports() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let members = corpus_members();
    let folder = write_folder(tmp.path(), &members);
    let zip = write_zip(
        tmp.path(),
        &members,
        zip::CompressionMethod::Deflated,
        "deflated",
    );

    for (label, path) in [("folder", folder.as_path()), ("zip", zip.as_path())] {
        let facts = preview_facts(path);
        assert!(
            facts.discovered.contains(&CONTROL.to_string()),
            "{label}: the control is discovered"
        );
        assert!(
            !facts.selectable.contains(&CONTROL.to_string()),
            "{label}: a NUL-bearing, dominantly-invalid member must never be \
             importable as log events"
        );
        assert!(
            !facts.selected.contains(&CONTROL.to_string()),
            "{label}: and must never be preselected"
        );
    }
}

/// The straddling fixture really is valid UTF-8 and really does place a
/// code point across the boundary — if this ever stopped being true, the
/// pin above would be measuring nothing.
#[test]
fn the_straddling_fixture_is_valid_text_and_actually_straddles() {
    let bytes = rotated_primary_log();
    assert!(
        std::str::from_utf8(&bytes).is_ok(),
        "valid UTF-8 end to end"
    );
    assert!(!bytes.contains(&0), "no NUL anywhere");
    assert!(
        bytes.len() > STREAM_CHUNK_BYTES * 3,
        "large enough to be streamed in several chunks"
    );

    let first = &bytes[..STREAM_CHUNK_BYTES];
    let second = &bytes[STREAM_CHUNK_BYTES..STREAM_CHUNK_BYTES * 2];
    assert!(
        std::str::from_utf8(first).is_err(),
        "chunk 0 ends mid-code-point"
    );
    let error = std::str::from_utf8(second).expect_err("chunk 1 starts mid-code-point");
    assert_eq!(
        error.valid_up_to(),
        0,
        "chunk 1 begins with continuation bytes — this is exactly the shape \
         the trailing-split tolerance does not cover"
    );
    assert!(
        error.error_len().is_some(),
        "and it is a hard error, not a truncation, which is why the \
         tolerance is skipped"
    );
}
