//! Log parsing and framing conformance laboratory.
//!
//! This is an **acceptance-oracle lane**, not a parser implementation. It
//! states, as data, what ContextDesk should produce for real-world log shapes
//! that current production does not yet handle — PostgreSQL stderr/csvlog/
//! jsonlog, timestamp alias and unit matrices, multi-line exception renderings,
//! and hostile mixed input.
//!
//! Three kinds of expectation live here, and they are never mixed up:
//!
//! 1. `holds` — behavior that is already correct on `main`. Asserted directly;
//!    a regression fails the default suite.
//! 2. `gap` — a known failure. The oracle records both the desired result and
//!    the behavior actually observed today, plus the owning issue. The default
//!    suite asserts the **observed** value, so CI stays green while the gap is
//!    impossible to forget: the moment production improves, the quarantine
//!    fails and forces an explicit reclassification. A gap is never silently
//!    weakened into a passing expectation.
//! 3. invariant — properties that must hold in every state, before and after
//!    any gap is repaired. No record dropped, no wall clock fabricated, source
//!    identity distinct, false continuation never merged.
//!
//! Driving the repair from red to green:
//!
//! ```text
//! cargo test -p cd-core --test log_conformance -- --ignored --nocapture strict
//! ```
//!
//! `strict` asserts the *desired* result for every case including gaps, so it
//! is red today by construction and turns green as production parser work
//! lands. It is `#[ignore]`d precisely so a permanently-failing test is never
//! committed to default CI.
//!
//! Refreshing what production currently does:
//!
//! ```text
//! cargo test -p cd-core --test log_conformance -- --ignored --nocapture observe
//! ```
//!
//! Every fixture byte is synthetic and derived from public format
//! documentation. See `scripts/generate_conformance_corpus.py`.

use cd_core::log_analysis::{
    ingest_path, query_events, query_facets, EventQuery, ExplorerEvent, LogCorpus, MAX_EVENT_PAGE,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const ORACLE_SCHEMA_VERSION: u64 = 1;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

fn lab_root() -> PathBuf {
    repo_root().join("fixtures/log-conformance")
}

fn corpus_root() -> PathBuf {
    lab_root().join("corpus")
}

fn oracle() -> &'static Value {
    static ORACLE: OnceLock<Value> = OnceLock::new();
    ORACLE.get_or_init(|| {
        let path = lab_root().join("cases.v1.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
    })
}

fn cases() -> &'static Vec<Value> {
    oracle()["cases"]
        .as_array()
        .expect("cases must be an array")
}

// ---------------------------------------------------------------------------
// Driving the real pipeline
// ---------------------------------------------------------------------------

/// Ingest one corpus path through the real production pipeline.
///
/// Nothing here reaches into parser internals: the lab asserts what a user
/// would actually get from an import, which is the only thing an acceptance
/// oracle may honestly claim. Results are memoized because many cases share
/// one input.
fn records_for(input: &str) -> Vec<ExplorerEvent> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, Vec<ExplorerEvent>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(BTreeMap::new()));
    if let Some(hit) = cache.lock().expect("cache lock").get(input) {
        return hit.clone();
    }

    let path = corpus_root().join(input);
    assert!(path.exists(), "corpus input missing: {}", path.display());
    let dir = tempfile::tempdir().expect("temp cache");
    let report = ingest_path(dir.path(), &path, input, None, "")
        .unwrap_or_else(|e| panic!("{input}: ingest failed: {e:?}"));
    let corpus = LogCorpus::open(dir.path(), &report.corpus_id)
        .unwrap_or_else(|e| panic!("{input}: corpus open failed: {e:?}"));
    let query = EventQuery {
        limit: MAX_EVENT_PAGE,
        ..Default::default()
    };
    let events = query_events(&corpus, &query)
        .unwrap_or_else(|e| panic!("{input}: query failed: {e:?}"))
        .events;

    cache
        .lock()
        .expect("cache lock")
        .insert(input.to_string(), events.clone());
    events
}

/// Read one comparable field off a record, in the oracle's vocabulary.
fn field_value(event: &ExplorerEvent, field: &str) -> Value {
    match field {
        "ts" => Value::from(event.ts),
        "timestamp_provenance" => serde_json::to_value(event.timestamp_provenance).expect("serde"),
        "active_timestamp_basis" => {
            serde_json::to_value(event.active_timestamp_basis).expect("serde")
        }
        "unresolved_local_timestamp" => match &event.unresolved_local_timestamp {
            Some(text) => Value::from(text.clone()),
            None => Value::Null,
        },
        "level" => Value::from(event.level.clone()),
        "service" => option_value(&event.service),
        "host" => option_value(&event.host),
        "trace_id" => option_value(&event.trace_id),
        "message" => Value::from(event.message.clone()),
        "message_chars" => Value::from(event.message.chars().count()),
        "source" => Value::from(event.source.clone()),
        other => panic!("oracle uses unknown field `{other}`"),
    }
}

fn option_value(value: &Option<String>) -> Value {
    match value {
        Some(text) => Value::from(text.clone()),
        None => Value::Null,
    }
}

/// Locate the single record an expectation refers to.
///
/// An exact message match wins, so a needle that is also a prefix of a longer
/// message (`offsetless local` vs `offsetless local with space`) stays
/// unambiguous rather than silently matching two records.
fn locate<'a>(events: &'a [ExplorerEvent], needle: &str, case_id: &str) -> &'a ExplorerEvent {
    let exact: Vec<&ExplorerEvent> = events.iter().filter(|e| e.message == needle).collect();
    if exact.len() == 1 {
        return exact[0];
    }
    let matches: Vec<&ExplorerEvent> = events
        .iter()
        .filter(|e| e.message.contains(needle))
        .collect();
    assert_eq!(
        matches.len(),
        1,
        "{case_id}: `where_contains` must identify exactly one record, matched {} for {needle:?}",
        matches.len()
    );
    matches[0]
}

/// Evaluate one assertion. Returns `Ok(())` or a human-readable mismatch.
fn evaluate(case: &Value, assertion: &Value) -> Result<(), String> {
    let case_id = case["id"].as_str().expect("case id");
    let input = case["input"].as_str().expect("case input");
    let events = records_for(input);
    let kind = assertion["kind"].as_str().expect("assertion kind");

    match kind {
        "record_count" => {
            let want = assertion["value"].as_u64().expect("record_count value");
            let got = events.len() as u64;
            if got == want {
                Ok(())
            } else {
                Err(format!("record_count: expected {want}, produced {got}"))
            }
        }
        "records_containing" => {
            let needle = assertion["where_contains"]
                .as_str()
                .expect("where_contains");
            let want = assertion["value"].as_u64().expect("value");
            let got = events.iter().filter(|e| e.message.contains(needle)).count() as u64;
            if got == want {
                Ok(())
            } else {
                Err(format!(
                    "records_containing {needle:?}: expected {want}, produced {got}"
                ))
            }
        }
        "record_field" => {
            let needle = assertion["where_contains"]
                .as_str()
                .expect("where_contains");
            let field = assertion["field"].as_str().expect("field");
            let want = &assertion["value"];
            let event = locate(&events, needle, case_id);
            let got = field_value(event, field);
            if &got == want {
                Ok(())
            } else {
                Err(format!("{field}: expected {want}, produced {got}"))
            }
        }
        "sources" => {
            let want: BTreeSet<String> = assertion["value"]
                .as_array()
                .expect("sources value")
                .iter()
                .map(|v| v.as_str().expect("source string").to_string())
                .collect();
            let got: BTreeSet<String> = events.iter().map(|e| e.source.clone()).collect();
            if got == want {
                Ok(())
            } else {
                Err(format!("sources: expected {want:?}, produced {got:?}"))
            }
        }
        other => panic!("{case_id}: unknown assertion kind `{other}`"),
    }
}

fn is_gap(case: &Value) -> bool {
    case["status"].as_str() == Some("gap")
}

fn is_invariant(case: &Value) -> bool {
    case["invariant"].as_bool() == Some(true)
}

// ---------------------------------------------------------------------------
// Oracle shape
// ---------------------------------------------------------------------------

#[test]
fn the_oracle_is_well_formed() {
    let oracle = oracle();
    assert_eq!(
        oracle["schema_version"].as_u64(),
        Some(ORACLE_SCHEMA_VERSION)
    );
    assert_eq!(
        oracle["oracle_version"].as_str(),
        Some("contextdesk.log_conformance.v1")
    );
    assert!(
        oracle["provenance"].as_str().is_some_and(|s| !s.is_empty()),
        "the oracle must state its provenance"
    );
    let known_issues: BTreeSet<&str> = oracle["issues"]
        .as_object()
        .expect("issues map")
        .keys()
        .map(|k| k.as_str())
        .collect();

    let mut ids = BTreeSet::new();
    for case in cases() {
        let id = case["id"].as_str().expect("case id");
        assert!(ids.insert(id), "duplicate case id {id}");
        for field in [
            "id",
            "family",
            "dimension",
            "input",
            "title",
            "status",
            "desired",
        ] {
            assert!(!case[field].is_null(), "{id}: missing `{field}`");
        }
        let status = case["status"].as_str().unwrap();
        assert!(
            matches!(status, "holds" | "gap"),
            "{id}: status must be holds or gap, got {status}"
        );
        assert!(
            corpus_root().join(case["input"].as_str().unwrap()).exists(),
            "{id}: input does not exist"
        );

        if status == "gap" {
            let issue = case["issue"]
                .as_str()
                .unwrap_or_else(|| panic!("{id}: a gap must name its owning issue"));
            assert!(
                known_issues.contains(issue),
                "{id}: unknown issue `{issue}`"
            );
            assert!(
                !case["observed"].is_null(),
                "{id}: a gap must record the behavior observed today"
            );
            // The load-bearing rule: a gap whose desired result equals what
            // production already does is not a gap. Without this, weakening a
            // desired value to match reality would quietly retire the case.
            assert_ne!(
                case["desired"], case["observed"],
                "{id}: desired equals observed — this is not a gap. Reclassify it \
                 as `holds` deliberately rather than weakening the expectation."
            );
            assert!(
                !is_invariant(case),
                "{id}: an invariant cannot also be a known gap"
            );
        } else {
            assert!(
                case["observed"].is_null(),
                "{id}: a holding case must not carry an `observed` value"
            );
        }
    }
    assert!(
        cases().len() >= 40,
        "the lab lost coverage: {} cases",
        cases().len()
    );
}

#[test]
fn every_declared_dimension_is_covered() {
    // The goal requires explicit expectations across all seven dimensions.
    // A dimension that quietly loses its last case would leave a hole the
    // count check above cannot see.
    let covered: BTreeSet<&str> = cases()
        .iter()
        .map(|c| c["dimension"].as_str().unwrap())
        .collect();
    for required in [
        "record_boundary",
        "timestamp_provenance",
        "timestamp_evidence",
        "level",
        "message",
        "structured_fields",
        "source_identity",
        "raw_representation",
        "fallback",
    ] {
        assert!(covered.contains(required), "no case covers `{required}`");
    }
}

// ---------------------------------------------------------------------------
// The three expectation classes
// ---------------------------------------------------------------------------

#[test]
fn every_holding_expectation_still_holds() {
    let mut failures = Vec::new();
    for case in cases().iter().filter(|c| !is_gap(c)) {
        if let Err(why) = evaluate(case, &case["desired"]) {
            failures.push(format!("{}: {why}", case["id"].as_str().unwrap()));
        }
    }
    assert!(
        failures.is_empty(),
        "behavior that was correct on main has regressed:\n{}",
        failures.join("\n")
    );
}

#[test]
fn every_gap_still_shows_the_behavior_it_recorded() {
    // Quarantine, not amnesty. If production improves, this fails and the case
    // must be reclassified by hand — the gap can never rot into a silent pass.
    let mut surprises = Vec::new();
    for case in cases().iter().filter(|c| is_gap(c)) {
        if let Err(why) = evaluate(case, &case["observed"]) {
            surprises.push(format!(
                "{} (owner #{}): {why}\n    desired: {}",
                case["id"].as_str().unwrap(),
                case["issue"].as_str().unwrap(),
                case["desired"]
            ));
        }
    }
    assert!(
        surprises.is_empty(),
        "production no longer matches a recorded gap. If the desired behavior now \
         holds, reclassify the case to `holds` and delete its `observed` block:\n{}",
        surprises.join("\n")
    );
}

#[test]
fn every_invariant_holds() {
    // Invariants are asserted on their own so a failure names the property
    // rather than getting lost among ordinary holding cases.
    let mut broken = Vec::new();
    for case in cases().iter().filter(|c| is_invariant(c)) {
        if let Err(why) = evaluate(case, &case["desired"]) {
            broken.push(format!(
                "{}: {}\n    {why}",
                case["id"].as_str().unwrap(),
                case["title"].as_str().unwrap()
            ));
        }
    }
    assert!(
        broken.is_empty(),
        "an invariant that must survive every parser change is broken:\n{}",
        broken.join("\n")
    );
}

#[test]
fn no_input_ever_loses_every_record() {
    // The strongest global property: whatever the parser does with a hostile
    // input, evidence never disappears entirely.
    let inputs: BTreeSet<&str> = cases()
        .iter()
        .map(|c| c["input"].as_str().unwrap())
        .collect();
    for input in inputs {
        assert!(
            !records_for(input).is_empty(),
            "{input}: import produced no records at all"
        );
    }
}

// ---------------------------------------------------------------------------
// Harness integrity — always green, proves the lab can actually fail
// ---------------------------------------------------------------------------

/// Build a copy of a real case with one expectation value replaced.
fn corrupt(case_id: &str, patch: impl FnOnce(&mut Value)) -> Value {
    let mut case = cases()
        .iter()
        .find(|c| c["id"].as_str() == Some(case_id))
        .unwrap_or_else(|| panic!("no case {case_id}"))
        .clone();
    patch(&mut case);
    case
}

#[test]
fn a_corrupted_record_boundary_is_detected() {
    let case = corrupt("false-continuation-not-merged", |c| {
        c["desired"]["value"] = Value::from(3);
    });
    let result = evaluate(&case, &case["desired"]);
    assert!(
        result.is_err(),
        "the harness accepted a false record boundary"
    );
    assert!(
        result.unwrap_err().contains("record_count"),
        "the failure must name the boundary mismatch"
    );
}

#[test]
fn a_corrupted_timestamp_is_detected() {
    // One second is enough: the comparison must be exact, not approximate.
    let case = corrupt("json-ts-rfc3339-utc", |c| {
        c["desired"]["value"] = Value::from(1_749_988_801i64);
    });
    let result = evaluate(&case, &case["desired"]);
    assert!(result.is_err(), "the harness accepted a false timestamp");
    assert!(
        result.unwrap_err().contains("ts:"),
        "the failure must name ts"
    );
}

#[test]
fn a_corrupted_timestamp_provenance_is_detected() {
    // Claiming a wall clock where production correctly reports order-only is
    // the exact failure this lab exists to catch.
    let case = corrupt("json-ts-linux-calendar-no-guess", |c| {
        c["desired"]["value"] = Value::from("explicit_wall_clock");
    });
    assert!(
        evaluate(&case, &case["desired"]).is_err(),
        "the harness accepted a fabricated wall clock"
    );
}

#[test]
fn a_corrupted_level_is_detected() {
    let case = corrupt("severity-negation-not-inferred", |c| {
        c["desired"]["value"] = Value::from("error");
    });
    let result = evaluate(&case, &case["desired"]);
    assert!(result.is_err(), "the harness accepted a false level");
    assert!(result.unwrap_err().contains("level:"));
}

#[test]
fn a_corrupted_source_identity_is_detected() {
    let case = corrupt("duplicate-basename-source-identity", |c| {
        c["desired"]["value"] = serde_json::json!(["app.log"]);
    });
    assert!(
        evaluate(&case, &case["desired"]).is_err(),
        "the harness accepted collapsed source identities"
    );
}

#[test]
fn an_ambiguous_record_selector_is_rejected() {
    // `offsetless local` is a prefix of `offsetless local with space`. The
    // selector must resolve that by exact match rather than silently picking
    // one of two records.
    let events = records_for("structured/json-ts-matrix.log");
    let chosen = locate(&events, "offsetless local", "selector-probe");
    assert_eq!(
        chosen.message, "offsetless local",
        "the selector picked the wrong record of an ambiguous pair"
    );
    let ambiguous = std::panic::catch_unwind(|| {
        let events = records_for("structured/json-ts-matrix.log");
        locate(&events, "epoch", "probe").message.clone()
    });
    assert!(
        ambiguous.is_err(),
        "a genuinely ambiguous selector must panic rather than guess"
    );
}

// ---------------------------------------------------------------------------
// Privacy scan for this root
// ---------------------------------------------------------------------------

/// Every file under `fixtures/log-conformance/`.
fn lab_files() -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![lab_root()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

#[test]
fn the_conformance_corpus_carries_nothing_private() {
    // The Log Lab scanner in `log_lab_generator::verify_safety` still guards
    // fixtures/log-lab and is deliberately untouched. It cannot guard this
    // root: it treats any dotted token ending in an alphabetic label as a
    // suspected public hostname, which is right for an incident corpus but
    // rejects `java.sql.SQLException`, `django.db.utils.OperationalError`, and
    // `public.orders` — precisely the content a parser conformance lab must
    // contain. This check keeps every substantive privacy rule and is stricter
    // on credentials: this corpus has no credential cases, so any credential
    // shape at all is a failure rather than an approved marker.
    let home = std::env::var("HOME").ok().filter(|v| v.len() > 1);
    let markers: Vec<String> = ["USER", "LOGNAME", "HOSTNAME"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|v| v.len() >= 8)
        .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();

    let mut failures = Vec::new();
    for path in lab_files() {
        let rel = path
            .strip_prefix(lab_root())
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        if rel == "README.md" {
            continue;
        }
        let bytes = std::fs::read(&path).expect("read fixture");
        let text = String::from_utf8_lossy(&bytes);

        for needle in ["/Users/", "/home/", "C:\\Users\\"] {
            if text.contains(needle) {
                failures.push(format!("{rel}: absolute home-shaped path `{needle}`"));
            }
        }
        if let Some(home) = &home {
            if text.contains(home.as_str()) {
                failures.push(format!("{rel}: contains the current HOME value"));
            }
        }
        for marker in &markers {
            if text.contains(marker.as_str()) {
                failures.push(format!("{rel}: contains a current-environment value"));
            }
        }
        if text.contains("sk-") || text.contains("Bearer ") {
            failures.push(format!(
                "{rel}: credential shape in a corpus that needs none"
            ));
        }
        for token in text.split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '"' | '\'' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}'
                )
        }) {
            // Real log records carry values as `key=value` and `"key":value`.
            // Inspecting only the whole token would let `client=8.8.8.8` and
            // `url=https://elsewhere` walk straight past every rule below.
            let after_sep = token
                .rsplit_once('=')
                .map(|(_, v)| v)
                .or_else(|| token.rsplit_once(':').map(|(_, v)| v))
                .unwrap_or(token);
            for part in [token, after_sep] {
                let candidate = part.trim_matches(|c: char| {
                    matches!(c, ':' | '=' | '/' | '<' | '>' | '.' | '?' | '&')
                });
                if let Ok(std::net::IpAddr::V4(ip)) = candidate.parse::<std::net::IpAddr>() {
                    let documentation = matches!(
                        ip.octets(),
                        [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
                    );
                    if !documentation {
                        failures.push(format!("{rel}: non-documentation IPv4 `{ip}`"));
                    }
                }
                if part.starts_with("http://") || part.starts_with("https://") {
                    let reserved = [".example", ".test", ".invalid"]
                        .iter()
                        .any(|suffix| part.contains(suffix));
                    if !reserved {
                        failures.push(format!("{rel}: non-reserved URL `{part}`"));
                    }
                }
                // An integer inside five minutes of now would pin the corpus to
                // this machine's clock and break determinism.
                if let Ok(value) = candidate.parse::<u64>() {
                    if value.abs_diff(now) <= 300
                        || value.abs_diff(now.saturating_mul(1000)) <= 300_000
                    {
                        failures.push(format!("{rel}: current-clock epoch `{value}`"));
                    }
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "conformance corpus privacy failures:\n{}",
        failures.join("\n")
    );
}

#[test]
fn the_corpus_stays_bounded() {
    // A conformance corpus earns its keep by being small enough to read. The
    // 25k stress variants are generated at test time and never committed.
    let total: u64 = lab_files()
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .sum();
    assert!(
        total < 512 * 1024,
        "the committed conformance lab grew to {total} bytes; stress variants belong in \
         generated output, not in Git"
    );
}

// ---------------------------------------------------------------------------
// Report and red-to-green driver
// ---------------------------------------------------------------------------

fn report_lines() -> (Vec<String>, usize, usize) {
    let mut lines = Vec::new();
    let mut green = 0usize;
    let mut red = 0usize;
    let mut by_family: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    for case in cases() {
        let id = case["id"].as_str().unwrap();
        let family = case["family"].as_str().unwrap();
        let entry = by_family.entry(family).or_insert((0, 0));
        match evaluate(case, &case["desired"]) {
            Ok(()) => {
                green += 1;
                entry.0 += 1;
                lines.push(format!("  PASS  {family:<18} {id}"));
            }
            Err(why) => {
                red += 1;
                entry.1 += 1;
                let owner = case["issue"].as_str().unwrap_or("-");
                lines.push(format!("  FAIL  {family:<18} {id}  (#{owner}) {why}"));
            }
        }
    }
    lines.push(String::new());
    for (family, (pass, fail)) in by_family {
        lines.push(format!(
            "  {family:<18} {pass} desired met, {fail} outstanding"
        ));
    }
    (lines, green, red)
}

#[test]
#[ignore = "red-to-green driver: asserts the DESIRED result for every case, including known gaps"]
fn strict() {
    let (lines, green, red) = report_lines();
    println!("\nContextDesk log conformance — desired behavior\n");
    for line in &lines {
        println!("{line}");
    }
    println!("\n  {green} of {} desired expectations met\n", green + red);
    assert_eq!(
        red, 0,
        "{red} desired expectations are not met yet. This test is red by \
         construction until the parser work lands; it is never part of default CI."
    );
}

#[test]
#[ignore = "observation tool: prints what production currently produces"]
fn observe() {
    let inputs: BTreeSet<&str> = cases()
        .iter()
        .map(|c| c["input"].as_str().unwrap())
        .collect();
    let mut out = serde_json::Map::new();
    for input in inputs {
        let events = records_for(input);
        let records: Vec<Value> = events
            .iter()
            .map(|e| {
                serde_json::json!({
                    "ts": e.ts,
                    "timestamp_provenance": e.timestamp_provenance,
                    "unresolved_local_timestamp": e.unresolved_local_timestamp,
                    "level": e.level,
                    "trace_id": e.trace_id,
                    "message": e.message,
                    "source": e.source,
                })
            })
            .collect();
        out.insert(
            input.to_string(),
            serde_json::json!({ "record_count": records.len(), "records": records }),
        );
    }
    println!(
        "CONFORMANCE_OBSERVATION {}",
        serde_json::to_string(&Value::Object(out)).expect("serialize")
    );
}

// ---------------------------------------------------------------------------
// Bounded stress variant
// ---------------------------------------------------------------------------

/// Build a deterministic 25k-record stress corpus from the committed shapes.
///
/// Generated at test time and never committed: the value is in the shapes,
/// which are already in Git, not in 25,000 copies of them. No clock and no
/// randomness, so two runs are byte-identical.
fn write_stress_corpus(dir: &Path, records: usize) -> std::io::Result<u64> {
    use std::io::Write;
    let structured = dir.join("stress-structured.log");
    let multiline = dir.join("stress-multiline.log");
    let mut s = std::io::BufWriter::new(std::fs::File::create(&structured)?);
    let mut m = std::io::BufWriter::new(std::fs::File::create(&multiline)?);

    const BASE: i64 = 1_749_988_800;
    let levels = ["info", "warn", "error", "debug"];
    let mut logical = 0u64;
    for index in 0..records {
        let ts = BASE + (index as i64 % 86_400);
        let level = levels[index % levels.len()];
        writeln!(
            s,
            "{{\"ts\":{ts},\"level\":\"{level}\",\"message\":\"stress record {index}\",\"service\":\"gateway\"}}"
        )?;
        logical += 1;
        // Every eighth record is a multi-line exception, so the stress corpus
        // exercises framing rather than only volume.
        if index % 8 == 0 {
            writeln!(
                m,
                "2025-06-15 13:00:00,{:03} ERROR [com.example.svc.Stress] (worker-{index}) failure {index}",
                index % 1000
            )?;
            writeln!(m, "java.sql.SQLException: synthetic failure {index}")?;
            writeln!(
                m,
                "\tat com.example.svc.Stress.handle(Stress.java:{})",
                index % 500
            )?;
            writeln!(m, "Caused by: java.net.ConnectException: refused")?;
            writeln!(m, "\t... {} more", index % 20)?;
            logical += 1;
        }
    }
    s.flush()?;
    m.flush()?;
    Ok(logical)
}

#[test]
#[ignore = "bounded 25k stress variant; generated at test time, never committed"]
fn stress() {
    const RECORDS: usize = 25_000;
    let dir = tempfile::tempdir().expect("temp corpus");
    let logical = write_stress_corpus(dir.path(), RECORDS).expect("write stress corpus");

    // Determinism: a second generation into a fresh directory is byte-identical.
    let twin = tempfile::tempdir().expect("temp corpus twin");
    write_stress_corpus(twin.path(), RECORDS).expect("write twin");
    for name in ["stress-structured.log", "stress-multiline.log"] {
        let a = std::fs::read(dir.path().join(name)).expect("read a");
        let b = std::fs::read(twin.path().join(name)).expect("read b");
        assert_eq!(a, b, "{name}: stress generation is not deterministic");
    }

    let started = std::time::Instant::now();
    let cache = tempfile::tempdir().expect("temp cache");
    let report = ingest_path(cache.path(), dir.path(), "conformance-stress", None, "")
        .expect("stress ingest");
    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).expect("open stress corpus");
    let elapsed = started.elapsed();

    let query = EventQuery {
        limit: MAX_EVENT_PAGE,
        ..Default::default()
    };
    let page = query_events(&corpus, &query).expect("query stress corpus");

    // The physical-line count is what today's pipeline produces. Stated as an
    // observation, never as a performance or correctness threshold: this
    // machine is not a universal budget.
    let physical = RECORDS as u64 + (RECORDS as u64).div_ceil(8) * 5;
    println!(
        "stress: {RECORDS} structured records + {} exception blocks\n  \
         desired logical records: {logical}\n  \
         physical records today:  {physical}\n  \
         ingested in {:?} on this machine (not a threshold)",
        (RECORDS as u64).div_ceil(8),
        elapsed
    );

    assert!(
        page.events.len() as u64 > 0,
        "the stress corpus produced no records"
    );
    assert!(
        logical < physical,
        "the stress corpus must exercise framing, not only volume"
    );
    // The invariant that matters at scale: two distinct sources stay distinct.
    // Facets cover the whole corpus; one page would only prove that the first
    // MAX_EVENT_PAGE rows happened to come from one file.
    let facets = query_facets(&corpus, &query).expect("stress facets");
    assert!(
        facets.sources.len() >= 2,
        "source identity collapsed at scale: {:?}",
        facets.sources.keys().collect::<Vec<_>>()
    );
    let total: u64 = facets.sources.values().sum();
    assert_eq!(
        total, physical,
        "the stress import lost records: expected {physical}, stored {total}"
    );
}

#[test]
#[ignore = "prints the current coverage and pass/fail inventory"]
fn report() {
    let (lines, green, red) = report_lines();
    println!("\nContextDesk log conformance inventory\n");
    for line in &lines {
        println!("{line}");
    }
    println!("\n  desired met: {green}   outstanding: {red}\n");
}
