//! Deterministic, public-safe company-shaped log fixture generator.
//!
//! The generator intentionally contains only invented identifiers and payloads.
//! Its aggregate truth lives outside generated import roots so consumers cannot
//! learn the answer from the corpus itself.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

/// Stderr record counts observed as structural requirements, not copied text.
pub const STDERR_RUN_RECORDS: [usize; 4] = [60, 71, 81, 226];
pub const APP_RENDERINGS_PER_GROUP: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureScenario {
    SmallCi,
    LargerOptional,
}

impl FixtureScenario {
    pub const fn multiplier(self) -> usize {
        match self {
            Self::SmallCi => 1,
            // Large enough to exercise repetition without becoming a default CI cost.
            Self::LargerOptional => 12,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureVariant {
    Anchored,
    Unanchored,
    StaticReusedTrace,
    ConflictingKeys,
}

#[derive(Debug, Clone)]
pub struct GeneratedFixture {
    pub app_renderings: usize,
    pub stderr_records: usize,
    pub expected_citation_ids: BTreeSet<String>,
    pub stderr_run_record_counts: Vec<usize>,
}

impl GeneratedFixture {
    pub fn citable_records(&self) -> usize {
        self.expected_citation_ids.len()
    }
}

/// Write a company-shaped fixture using only synthetic log payloads.
///
/// The generated tree intentionally never contains a truth manifest. The
/// evaluator-owned manifest belongs in `fixtures/.../evaluator-truth/`.
pub fn write_company_shaped_fixture(
    root: &Path,
    scenario: FixtureScenario,
    variant: FixtureVariant,
) -> GeneratedFixture {
    fs::create_dir_all(root).expect("create synthetic fixture root");
    let multiplier = scenario.multiplier();
    let mut current = String::new();
    let mut rotated = String::new();
    let mut citation_ids = BTreeSet::new();
    let mut app_renderings = 0;

    for group in 0..multiplier {
        for run in 0..APP_RENDERINGS_PER_GROUP {
            let global_run = group * APP_RENDERINGS_PER_GROUP + run;
            let citation = format!("app-{global_run:03}");
            let anchor = app_anchor(variant, global_run);
            let stack = application_stack(global_run, &citation, anchor.as_deref());
            if run < 2 {
                rotated.push_str(&stack);
            } else {
                current.push_str(&stack);
            }
            citation_ids.insert(citation);
            app_renderings += 1;
        }
    }
    fs::write(root.join("server.log"), current).expect("write current server log");
    fs::write(root.join("server.log.1"), rotated).expect("write rotated server log");

    let mut stderr_run_record_counts = Vec::new();
    let mut stderr_records = 0;
    for group in 0..multiplier {
        for (run, base_records) in STDERR_RUN_RECORDS.iter().copied().enumerate() {
            let global_run = group * APP_RENDERINGS_PER_GROUP + run;
            let records = base_records;
            let file_name = format!("server.stderr.run-{group:02}-{run}.log");
            let mut body = String::new();
            let anchor = stderr_anchor(variant, global_run);
            for record in 0..records {
                let citation = format!("stderr-{global_run:03}-{record:03}");
                body.push_str(&stderr_record(
                    global_run,
                    record,
                    &citation,
                    anchor.as_deref(),
                ));
                citation_ids.insert(citation);
            }
            fs::write(root.join(file_name), body).expect("write timestamp-wrapped stderr run");
            stderr_run_record_counts.push(records);
            stderr_records += records;
        }
    }

    write_decoys(root);
    write_explicit_utc_rows(root);
    write_order_only_rows(root);

    GeneratedFixture {
        app_renderings,
        stderr_records,
        expected_citation_ids: citation_ids,
        stderr_run_record_counts,
    }
}

fn app_anchor(variant: FixtureVariant, run: usize) -> Option<String> {
    match variant {
        FixtureVariant::Anchored => Some(format!("trace_id=synthetic-trace-{run:03}")),
        FixtureVariant::Unanchored => None,
        FixtureVariant::StaticReusedTrace => Some("trace_id=synthetic-static-trace".into()),
        FixtureVariant::ConflictingKeys => Some(format!("trace_id=synthetic-app-{run:03}")),
    }
}

fn stderr_anchor(variant: FixtureVariant, run: usize) -> Option<String> {
    match variant {
        FixtureVariant::Anchored => Some(format!("trace_id=synthetic-trace-{run:03}")),
        FixtureVariant::Unanchored => None,
        FixtureVariant::StaticReusedTrace => Some("trace_id=synthetic-static-trace".into()),
        FixtureVariant::ConflictingKeys => Some(format!("trace_id=synthetic-stderr-{run:03}")),
    }
}

fn application_stack(run: usize, citation: &str, anchor: Option<&str>) -> String {
    let anchor = anchor.map(|value| format!(" {value}")).unwrap_or_default();
    let minute = 10 + run as u32;
    format!(
        "2017-05-10 14:{minute:02}:00,000 ERROR [org.example.synthetic.Service] (default task-{run}) java.lang.IllegalStateException: synthetic operation rejected synthetic-cite={citation}{anchor}\n\
         \tat org.example.synthetic.Service.step(Service.java:41)\n\
         \tat org.example.synthetic.Gateway.invoke(Gateway.java:27)\n\
         \tCaused by: java.io.IOException: synthetic upstream unavailable\n"
    )
}

fn stderr_record(run: usize, record: usize, citation: &str, anchor: Option<&str>) -> String {
    let anchor = anchor.map(|value| format!(" {value}")).unwrap_or_default();
    let minute = 10 + run as u32;
    let payload = if record == 0 {
        "java.lang.IllegalStateException: synthetic operation rejected".to_string()
    } else {
        format!(
            "at org.example.synthetic.Run{run}.frame{record}(Run{run}.java:{})",
            record + 10
        )
    };
    format!(
        "2017-05-10 14:{minute:02}:00,{record:03} ERROR [stderr] (pool-40-thread-{run}) {payload} synthetic-cite={citation}{anchor}\n"
    )
}

fn write_decoys(root: &Path) {
    fs::write(
        root.join("elasticsearch-decoy.log"),
        "2017-05-10 14:55:00,000 WARN [org.elasticsearch.client] (elastic-1) synthetic shard retry\n",
    )
    .expect("write elasticsearch decoy");
    fs::write(
        root.join("library-decoy.log"),
        "2017-05-10 14:56:00,000 ERROR [org.example.library] (worker-1) synthetic dependency warning\n",
    )
    .expect("write library decoy");
    fs::write(
        root.join("standalone-synthetic.conf"),
        "# synthetic configuration decoy\nsearch.cluster=synthetic-only\n",
    )
    .expect("write config decoy");
}

fn write_explicit_utc_rows(root: &Path) {
    fs::write(
        root.join("utc-audit.jsonl"),
        concat!(
            "{\"ts\":\"2017-05-10T16:30:00Z\",\"level\":\"info\",\"msg\":\"synthetic explicit utc audit one\"}\n",
            "{\"ts\":\"2017-05-10T16:31:00Z\",\"level\":\"info\",\"msg\":\"synthetic explicit utc audit two\"}\n"
        ),
    )
    .expect("write explicit utc rows");
}

fn write_order_only_rows(root: &Path) {
    fs::write(
        root.join("order-only.log"),
        "synthetic sequence marker alpha\nsynthetic sequence marker beta\nsynthetic sequence marker gamma\n",
    )
    .expect("write order-only rows");
}
