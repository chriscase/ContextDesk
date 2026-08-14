//! Retrieval-ablation cases rb01–rb10. Content rules: hosts end `.example`,
//! IPs stay in RFC 5737 ranges, credential shapes carry LOG-LAB-INVALID, and
//! no `alpha.alpha` dotted token outside reserved TLDs (the frozen Log Lab
//! safety scan treats those as public hostnames) — exception names are
//! dot-free and stack frames use slash paths.

use super::super::{RaFormat, RaKeywordPlan, RaRole};
use super::RaCaseBuilder;
use super::RaCaseSpec;

fn plan(terms: &[&str]) -> RaKeywordPlan {
    RaKeywordPlan::terms_only(terms)
}

fn plan_level(terms: &[&str], level: &str) -> RaKeywordPlan {
    let mut plan = RaKeywordPlan::terms_only(terms);
    plan.level = Some(level.into());
    plan
}

fn plan_service(terms: &[&str], services: &[&str]) -> RaKeywordPlan {
    let mut plan = RaKeywordPlan::terms_only(terms);
    plan.services = services.iter().map(|s| s.to_string()).collect();
    plan
}

// ---------------------------------------------------------------------------
// rb01 — lexically easy trigger
// ---------------------------------------------------------------------------

pub const RB01: RaCaseSpec = RaCaseSpec {
    case_id: "rb01-lexical-easy",
    case_version: 1,
    title: "Lexically easy trigger",
    intended_probe: "control: query and causal evidence share obvious terminology",
    day: 0,
    scale_cap: None,
    build: build_rb01,
};

fn build_rb01(b: &mut RaCaseBuilder) {
    b.source(
        "api/checkout.jsonl",
        "checkout-api",
        "api-01.example",
        RaFormat::Jsonl,
    );
    b.source(
        "edge/gateway.jsonl",
        "edge",
        "edge-01.example",
        RaFormat::Jsonl,
    );

    let chg = format!("chg-{}", b.rng.hex8_upper());
    let txn = format!("txn-{}", b.rng.hex8_upper());
    let req = format!("req-{}", b.rng.hex8_upper());
    let restore = format!("chg-{}", b.rng.hex8_upper());

    b.noise("api/checkout.jsonl", 0, 3000, 240, &mut |rng, _i| {
        (
            "info",
            format!(
                "request completed path=/api/cart status=200 duration_ms={} request=req-{}",
                40 + rng.next_range(300),
                rng.hex8()
            ),
        )
    });
    b.noise("edge/gateway.jsonl", 0, 3000, 140, &mut |rng, i| {
        if i % 40 == 0 {
            (
                "warn",
                format!(
                    "upstream latency budget 80 percent used request=req-{}",
                    rng.hex8()
                ),
            )
        } else {
            (
                "info",
                format!(
                    "GET /assets status=200 bytes={}",
                    500 + rng.next_range(9000)
                ),
            )
        }
    });

    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        chg.clone(),
        "wall",
        3060,
        "config change shrank the checkout timeout budget",
    );
    b.gevent(
        g_trigger,
        "api/checkout.jsonl",
        3060,
        "warn",
        &format!(
            "applied config change {chg} checkout timeout threshold lowered from 2000ms to 250ms"
        ),
    );

    let g_prop = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        txn.clone(),
        "wall",
        3120,
        "payment authorize retries breach the shrunken timeout",
    );
    for (offset, elapsed) in [(3120i64, 1483u64), (3180, 1512), (3240, 1477)] {
        b.gevent(
            g_prop,
            "api/checkout.jsonl",
            offset,
            "error",
            &format!("checkout timeout exceeded for payment authorize {txn} elapsed_ms={elapsed} limit_ms=250"),
        );
    }

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        req.clone(),
        "wall",
        3200,
        "edge returns 504 for checkout requests",
    );
    for offset in [3200i64, 3260] {
        b.gevent(
            g_symptom,
            "edge/gateway.jsonl",
            offset,
            "error",
            &format!("upstream timeout status=504 path=/api/checkout request={req}"),
        );
    }

    let g_recovery = b.group(
        "g04",
        RaRole::Recovery,
        Some("inc1"),
        restore.clone(),
        "wall",
        3600,
        "threshold restored; checkout latency normal again",
    );
    b.gevent(
        g_recovery,
        "api/checkout.jsonl",
        3600,
        "info",
        &format!("config change {restore} restored checkout timeout threshold to 2000ms"),
    );

    b.incident(
        "inc1",
        "A config change lowered the checkout timeout threshold; payment authorize calls then exceeded it, surfacing as edge 504s until the threshold was restored.",
        "established",
        &[g_trigger],
        3060,
        3660,
    );

    b.query(
        "q1",
        "broad",
        "What problems occurred in the checkout service this afternoon?",
        plan(&["checkout", "timeout", "error"]),
        true,
        &[(g_trigger, 3), (g_prop, 2), (g_symptom, 1), (g_recovery, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "What caused the checkout timeouts?",
        plan(&["checkout", "timeout", "threshold", "config"]),
        true,
        &[(g_trigger, 3), (g_prop, 2)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Which requests failed with 504?",
        plan(&["504", "timeout"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Show every event for {txn}."),
        plan(&[&txn]),
        true,
        &[(g_prop, 2)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Was there a database outage behind these failures?",
        plan(&["database", "outage"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is there any other supported explanation for the 504s besides the timeout change?",
        plan(&["504", "checkout", "config", "change"]),
        true,
        &[(g_trigger, 3), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "What happened first, and did the system recover?",
        plan(&["threshold", "restored", "timeout"]),
        true,
        &[(g_trigger, 3), (g_recovery, 1)],
        &[],
    );

    b.claims(
        &[
            "the checkout timeout threshold was lowered by a config change before the failures",
            "payment authorize calls exceeded the lowered threshold",
            "the edge 504s were symptoms, not the cause",
            "restoring the threshold preceded recovery",
        ],
        &[
            "the edge gateway itself failed",
            "a database outage caused the checkout timeouts",
        ],
        &[],
        &["exact user impact counts are not derivable from these logs"],
    );
    b.expect_pass(0.75, 0.25);
}

// ---------------------------------------------------------------------------
// rb02 — semantic wording gap
// ---------------------------------------------------------------------------

pub const RB02: RaCaseSpec = RaCaseSpec {
    case_id: "rb02-semantic-gap",
    case_version: 1,
    title: "Semantic wording gap",
    intended_probe: "query vocabulary (database availability) never appears in causal evidence (JDBC / IceCube / managed-connection vocabulary)",
    day: 1,
    scale_cap: None,
    build: build_rb02,
};

fn build_rb02(b: &mut RaCaseBuilder) {
    b.source(
        "appserver/server.log",
        "app-server",
        "app-01.example",
        RaFormat::Logfmt,
    );
    b.source(
        "platform/pg.log",
        "platform-db",
        "db-01.example",
        RaFormat::Logfmt,
    );

    let txn = format!("txn-{}", b.rng.hex8_upper());
    let cause = format!("cause-{}", b.rng.hex8_upper());
    let order = format!("ord-{}", b.rng.hex8_upper());

    b.noise("appserver/server.log", 0, 3000, 260, &mut |rng, i| {
        if i % 3 == 0 {
            (
                "info",
                format!(
                    "pool stats active={} idle={} waiting=0",
                    rng.next_range(8),
                    8 - rng.next_range(4)
                ),
            )
        } else if i % 17 == 0 {
            (
                "debug",
                format!(
                    "deployment scan completed in {} ms",
                    20 + rng.next_range(400)
                ),
            )
        } else {
            ("info", format!("session touch account=acct-{}", rng.hex8()))
        }
    });
    b.noise("platform/pg.log", 0, 3000, 160, &mut |rng, _i| {
        (
            "info",
            format!(
                "checkpoint complete wrote {} buffers",
                100 + rng.next_range(2000)
            ),
        )
    });

    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        "administrator command".into(),
        "wall",
        3100,
        "database process terminated sessions; wording never says database/outage/unavailable",
    );
    b.gevent(
        g_trigger,
        "platform/pg.log",
        3100,
        "error",
        "FATAL: terminating connection due to administrator command",
    );

    let g_pool = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        txn.clone(),
        "wall",
        3160,
        "IceCube managed-connection pool exhaustion",
    );
    for offset in [3160i64, 3220, 3280] {
        b.gevent(
            g_pool,
            "appserver/server.log",
            offset,
            "error",
            &format!("IceCubeConnectionPool unable to acquire ManagedConnection from pool java-pool-main after 30000ms {txn}"),
        );
    }

    let g_jdbc = b.group(
        "g03",
        RaRole::Propagation,
        Some("inc1"),
        cause.clone(),
        "wall",
        3240,
        "JDBC connect refusals to the documentation-range address",
    );
    for offset in [3240i64, 3300] {
        b.gevent(
            g_jdbc,
            "appserver/server.log",
            offset,
            "error",
            &format!("JDBC connection refused connect to 192.0.2.10:5432 sql-state=08001 acquisition failed {cause}"),
        );
    }

    let g_symptom = b.group(
        "g04",
        RaRole::Symptom,
        Some("inc1"),
        order.clone(),
        "wall",
        3320,
        "order submission fails at persistence time",
    );
    for offset in [3320i64, 3380] {
        b.gevent(
            g_symptom,
            "appserver/server.log",
            offset,
            "warn",
            &format!(
                "order submission failed could not persist entity Order {order} cause=timeout"
            ),
        );
    }

    let g_recovery = b.group(
        "g05",
        RaRole::Recovery,
        Some("inc1"),
        "ready to accept".into(),
        "wall",
        3700,
        "database process announces readiness",
    );
    b.gevent(
        g_recovery,
        "platform/pg.log",
        3700,
        "info",
        "system is ready to accept connections",
    );

    b.incident(
        "inc1",
        "The platform database terminated connections on an administrator command; the app server exhausted its IceCube managed-connection pool and refused JDBC connects until the database announced readiness.",
        "established",
        &[g_trigger],
        3100,
        3760,
    );

    b.query(
        "q1",
        "broad",
        "What went wrong on the platform tier this morning?",
        plan(&["failed", "error"]),
        true,
        &[(g_trigger, 3), (g_pool, 2), (g_jdbc, 2), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "Why did the database become unavailable?",
        plan(&["database", "unavailable"]),
        true,
        &[(g_trigger, 3), (g_pool, 2), (g_jdbc, 2)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Which orders failed to save?",
        plan(&["order", "failed", "persist"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Show every event for {txn}."),
        plan(&[&txn]),
        true,
        &[(g_pool, 2)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did the app server run out of memory?",
        plan(&["memory", "heap", "OutOfMemory"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Was this a network problem or a database problem?",
        plan(&["network", "database", "problem"]),
        true,
        &[(g_trigger, 3), (g_jdbc, 2)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "When did the platform recover?",
        plan(&["ready", "accept", "connections"]),
        true,
        &[(g_recovery, 1), (g_trigger, 3)],
        &[],
    );

    b.claims(
        &[
            "connection terminations on the database side preceded the pool exhaustion",
            "the IceCube pool exhaustion and JDBC refusals were propagation, not the root",
            "recovery corresponds to the readiness announcement",
        ],
        &[
            "the application server leaked memory",
            "a network partition caused the refusals",
        ],
        &[],
        &["the reason for the administrator command is outside this corpus"],
    );
    b.expect_limitation(
        "causal evidence uses JDBC/IceCube/managed-connection vocabulary; the words `database` and `unavailable` never appear in any causal record, so keyword retrieval cannot bridge q2/q6",
        &["q2", "q6"],
        None,
        Some(0.4),
    );
}

// ---------------------------------------------------------------------------
// rb03 — rare causal evidence inside a wildcard template
// ---------------------------------------------------------------------------

pub const RB03: RaCaseSpec = RaCaseSpec {
    case_id: "rb03-rare-causal",
    case_version: 1,
    title: "Rare causal evidence",
    intended_probe:
        "a handful of causal records hide inside a high-volume wildcard template family",
    day: 2,
    scale_cap: None,
    build: build_rb03,
};

fn build_rb03(b: &mut RaCaseBuilder) {
    b.source(
        "api/requests.jsonl",
        "upload-api",
        "api-02.example",
        RaFormat::Jsonl,
    );
    b.source(
        "worker/uploads.log",
        "upload-worker",
        "worker-01.example",
        RaFormat::Logfmt,
    );

    let rare = format!("req-{}", b.rng.hex8_upper());
    let fail = format!("req-{}", b.rng.hex8_upper());
    let job = format!("job-{}", b.rng.hex8_upper());

    // One wildcard-heavy family dominates the corpus.
    b.noise("api/requests.jsonl", 0, 5400, 815, &mut |rng, i| {
        let segment = ["orders", "profile", "search", "media", "cart"][(i % 5) as usize];
        (
            "info",
            format!(
                "request completed path=/api/{segment}/{} status=200 bytes={} request=req-{}",
                rng.next_range(100_000),
                200 + rng.next_range(48_000),
                rng.hex8()
            ),
        )
    });
    b.noise("worker/uploads.log", 0, 5400, 40, &mut |rng, _i| {
        (
            "info",
            format!(
                "upload job finished job=job-{} in {} ms",
                rng.hex8(),
                100 + rng.next_range(4000)
            ),
        )
    });

    // Three rare causal records share the wildcard family's shape but carry
    // the materially different storage-exhaustion fields.
    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        rare.clone(),
        "wall",
        2400,
        "storage exhaustion surfaces inside the generic completion template",
    );
    for (offset, free) in [(2400i64, 14u64), (2460, 9), (2520, 3)] {
        b.gevent(
            g_trigger,
            "api/requests.jsonl",
            offset,
            "info",
            &format!("request completed path=/api/upload/{} status=507 bytes=0 request={rare} disk_free_mb={free}", 40_000 + offset),
        );
    }

    let g_prop = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        job.clone(),
        "wall",
        2600,
        "worker aborts uploads on insufficient storage",
    );
    for offset in [2600i64, 2720] {
        b.gevent(
            g_prop,
            "worker/uploads.log",
            offset,
            "error",
            &format!("upload job aborted insufficient storage remaining job={job}"),
        );
    }

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        fail.clone(),
        "wall",
        2800,
        "user-visible upload failures",
    );
    for offset in [2800i64, 2860, 2920, 2980] {
        b.gevent(
            g_symptom,
            "api/requests.jsonl",
            offset,
            "error",
            &format!(
                "request failed path=/api/upload/{} status=500 request={fail}",
                60_000 + offset
            ),
        );
    }

    b.incident(
        "inc1",
        "Storage exhaustion (507 with disk_free_mb collapsing) inside the routine completion template caused worker aborts and then 500s on uploads.",
        "established",
        &[g_trigger],
        2400,
        3040,
    );

    b.query(
        "q1",
        "broad",
        "Are uploads healthy today?",
        plan(&["upload", "failed", "error"]),
        true,
        &[(g_trigger, 3), (g_prop, 2), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "Why did uploads start failing?",
        plan(&["upload", "failing", "cause"]),
        true,
        &[(g_trigger, 3), (g_prop, 2)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the failed upload requests.",
        plan(&["upload", "500", "failed"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find {rare}."),
        plan(&[&rare]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did an auth outage break uploads?",
        plan(&["auth", "denied", "unauthorized"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Could anything other than storage explain the upload failures?",
        plan(&["upload", "storage", "insufficient"]),
        true,
        &[(g_trigger, 3), (g_prop, 2)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Which came first: the worker aborts or the 500s?",
        plan(&["aborted", "500", "upload"]),
        true,
        &[(g_prop, 2), (g_symptom, 1)],
        &[],
    );

    b.claims(
        &[
            "disk_free_mb collapsing to single digits precedes every user-visible failure",
            "the 507 completions inside the routine template are the earliest causal evidence",
        ],
        &["upload volume alone caused the failures"],
        &[],
        &["absolute disk capacity is not in the corpus; only the free-space trend is"],
    );
    b.expect_limitation(
        "the causal 507/disk_free_mb records share the routine completion template and none of the natural causal query terms; they are reachable by identifier or storage vocabulary only",
        &["q2"],
        None,
        Some(0.5),
    );
}

// ---------------------------------------------------------------------------
// rb04 — frequency/severity decoy
// ---------------------------------------------------------------------------

pub const RB04: RaCaseSpec = RaCaseSpec {
    case_id: "rb04-frequency-decoy",
    case_version: 1,
    title: "Frequency and severity decoy",
    intended_probe:
        "thousands of high-severity repetitive errors compete with a small shutdown cascade",
    day: 3,
    scale_cap: None,
    build: build_rb04,
};

fn build_rb04(b: &mut RaCaseBuilder) {
    b.source(
        "db/database.log",
        "orders-db",
        "db-02.example",
        RaFormat::Logfmt,
    );
    b.source(
        "api/orders.jsonl",
        "orders-api",
        "api-03.example",
        RaFormat::Jsonl,
    );
    b.source(
        "ops/maintenance.jsonl",
        "ops-controller",
        "ops-01.example",
        RaFormat::Jsonl,
    );

    let mw = format!("mw-{}", b.rng.hex8_upper());
    let txn = format!("txn-{}", b.rng.hex8_upper());

    b.noise("api/orders.jsonl", 0, 5400, 200, &mut |rng, _i| {
        (
            "info",
            format!(
                "order placed order=ord-{} total_cents={}",
                rng.hex8(),
                500 + rng.next_range(90_000)
            ),
        )
    });
    b.noise("db/database.log", 0, 5400, 160, &mut |rng, _i| {
        (
            "info",
            format!(
                "autovacuum finished table=orders_{} pages={}",
                rng.next_range(8),
                rng.next_range(4000)
            ),
        )
    });

    // The decoy: a huge, repetitive, high-severity family that has nothing to
    // do with the outage.
    let g_decoy = b.group(
        "g00",
        RaRole::Decoy,
        None,
        "orders_search_idx".into(),
        "wall",
        60,
        "missing-index noise: loud, frequent, irrelevant to the outage",
    );
    {
        let count = b.scaled(1200);
        for index in 0..count {
            let at = 60 + ((index * 5340) / count) as i64;
            let q = b.rng.hex8_upper();
            b.gevent(
                g_decoy,
                "db/database.log",
                at,
                "error",
                &format!("missing index orders_search_idx sequential scan fallback query=q-{q}"),
            );
        }
        b.set_occurrences(g_decoy, count);
    }

    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        mw.clone(),
        "wall",
        3300,
        "maintenance-driven shutdown request",
    );
    b.gevent(
        g_trigger,
        "ops/maintenance.jsonl",
        3300,
        "info",
        &format!("maintenance window {mw} started failover drill for orders-db"),
    );
    b.gevent(
        g_trigger,
        "db/database.log",
        3310,
        "warn",
        &format!("received shutdown request from maintenance controller window={mw}"),
    );

    let g_prop = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        "connection slots exhausted".into(),
        "wall",
        3340,
        "restart exhausts connection slots",
    );
    for (offset, waiters) in [(3340i64, 7u64), (3360, 11), (3380, 16)] {
        b.gevent(
            g_prop,
            "db/database.log",
            offset,
            "error",
            &format!("connection slots exhausted during restart waiters={waiters}"),
        );
    }

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        txn.clone(),
        "wall",
        3400,
        "order placement fails while the database restarts",
    );
    for offset in [3400i64, 3430, 3460, 3490, 3520] {
        b.gevent(
            g_symptom,
            "api/orders.jsonl",
            offset,
            "error",
            &format!("order placement failed connection refused {txn}"),
        );
    }

    let g_recovery = b.group(
        "g04",
        RaRole::Recovery,
        Some("inc1"),
        "accepting connections again".into(),
        "wall",
        3650,
        "database returns and latency normalises",
    );
    b.gevent(
        g_recovery,
        "db/database.log",
        3650,
        "info",
        "accepting connections again after restart",
    );
    b.gevent(
        g_recovery,
        "api/orders.jsonl",
        3700,
        "info",
        "order placement latency normalized accepting connections again downstream",
    );

    b.incident(
        "inc1",
        "A maintenance failover drill restarted the orders database; order placement failed during the restart. The missing-index errors are constant background noise and unrelated.",
        "established",
        &[g_trigger],
        3300,
        3760,
    );

    b.query(
        "q1",
        "broad",
        "What is wrong with the orders system?",
        plan(&["orders", "error", "failed"]),
        true,
        &[(g_trigger, 3), (g_prop, 2), (g_symptom, 1)],
        &[g_decoy],
    );
    b.query(
        "q2",
        "causal",
        "What caused order placement to fail?",
        plan(&["order", "placement", "failed", "shutdown"]),
        true,
        &[(g_trigger, 3), (g_prop, 2)],
        &[g_decoy],
    );
    b.query(
        "q3",
        "symptom",
        "Show failed order placements.",
        plan(&["placement", "failed", "refused"]),
        true,
        &[(g_symptom, 1)],
        &[g_decoy],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Show all events for maintenance window {mw}."),
        plan(&[&mw]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did a missing index cause the outage?",
        plan(&["missing", "index", "outage"]),
        false,
        &[],
        &[g_decoy],
    );
    b.query(
        "q6",
        "competing",
        "Is the missing-index noise or the maintenance restart the better explanation for the failures?",
        plan(&["missing", "index", "shutdown", "maintenance"]),
        true,
        &[(g_trigger, 3), (g_prop, 2)],
        &[g_decoy],
    );
    b.query(
        "q7",
        "chronology",
        "Did the system recover, and what marked recovery?",
        plan(&["accepting", "connections", "normalized"]),
        true,
        &[(g_recovery, 1), (g_trigger, 3)],
        &[],
    );

    b.claims(
        &[
            "the maintenance shutdown request precedes the connection failures",
            "missing-index errors run at a constant rate before, during, and after the incident",
            "order placement recovered when the database accepted connections again",
        ],
        &[
            "the missing orders_search_idx index caused the order placement failures",
            "error volume implies the missing-index family is the incident",
        ],
        &[],
        &["the drill's intent is recorded; its authorisation chain is not"],
    );
    b.expect_limitation(
        "chronological keyword retrieval floods top-k with the high-frequency missing-index decoy for broad/causal phrasing; the cascade stays reachable via identifier and shutdown vocabulary",
        &["q1"],
        None,
        None,
    );
}

// ---------------------------------------------------------------------------
// rb05 — cross-source propagation
// ---------------------------------------------------------------------------

pub const RB05: RaCaseSpec = RaCaseSpec {
    case_id: "rb05-cross-source",
    case_version: 1,
    title: "Cross-source propagation",
    intended_probe: "trigger, propagation, symptoms and recovery use different vocabulary in database, app server, worker and client logs",
    day: 4,
    scale_cap: None,
    build: build_rb05,
};

fn build_rb05(b: &mut RaCaseBuilder) {
    b.source(
        "db/postgres.log",
        "postgres",
        "db-03.example",
        RaFormat::Plain,
    );
    b.source(
        "appserver/wildfly.log",
        "app-server",
        "app-02.example",
        RaFormat::Plain,
    );
    b.source(
        "worker/jobs.jsonl",
        "jobs-worker",
        "worker-02.example",
        RaFormat::Jsonl,
    );
    b.source(
        "client/edge.jsonl",
        "edge-client",
        "edge-02.example",
        RaFormat::Jsonl,
    );

    let job = format!("job-{}", b.rng.hex8_upper());
    let req = format!("req-{}", b.rng.hex8_upper());

    b.noise("worker/jobs.jsonl", 0, 4200, 220, &mut |rng, _i| {
        (
            "info",
            format!(
                "job finished job=job-{} items={}",
                rng.hex8(),
                rng.next_range(500)
            ),
        )
    });
    b.noise("client/edge.jsonl", 0, 4200, 260, &mut |rng, _i| {
        (
            "info",
            format!(
                "status=200 path=/storefront request=req-{} duration_ms={}",
                rng.hex8(),
                30 + rng.next_range(400)
            ),
        )
    });
    b.noise("db/postgres.log", 0, 4200, 90, &mut |rng, _i| {
        (
            "info",
            format!("checkpoint starting wal segment {}", rng.next_range(90_000)),
        )
    });
    b.noise("appserver/wildfly.log", 0, 4200, 90, &mut |rng, _i| {
        (
            "info",
            format!(
                "WFLYSRV0010 deployed batch artifact rev {}",
                rng.next_range(4_000)
            ),
        )
    });

    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        "smart shutdown request".into(),
        "wall",
        2500,
        "database-side vocabulary only",
    );
    b.gevent(
        g_trigger,
        "db/postgres.log",
        2500,
        "warn",
        "received smart shutdown request",
    );

    let g_appserver = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        "IJ000453".into(),
        "wall",
        2560,
        "app-server vocabulary: managed connection acquisition",
    );
    for offset in [2560i64, 2620] {
        b.gevent(
            g_appserver,
            "appserver/wildfly.log",
            offset,
            "error",
            "IJ000453 unable to obtain managed connection for datasource OrdersDS",
        );
    }

    let g_worker = b.group(
        "g03",
        RaRole::Propagation,
        Some("inc1"),
        job.clone(),
        "wall",
        2680,
        "worker vocabulary: retries on refused connections",
    );
    for offset in [2680i64, 2740] {
        b.gevent(
            g_worker,
            "worker/jobs.jsonl",
            offset,
            "warn",
            &format!("job retry scheduled connection refused job={job}"),
        );
    }

    let g_client = b.group(
        "g04",
        RaRole::Symptom,
        Some("inc1"),
        req.clone(),
        "wall",
        2800,
        "client vocabulary: 502 upstream connect",
    );
    for offset in [2800i64, 2840, 2880] {
        b.gevent(
            g_client,
            "client/edge.jsonl",
            offset,
            "error",
            &format!("status=502 upstream connect error path=/storefront request={req}"),
        );
    }

    let g_recovery = b.group(
        "g05",
        RaRole::Recovery,
        Some("inc1"),
        "database system is ready".into(),
        "wall",
        3400,
        "recovery across two sources",
    );
    b.gevent(
        g_recovery,
        "db/postgres.log",
        3400,
        "info",
        "database system is ready to accept connections",
    );
    b.gevent(
        g_recovery,
        "appserver/wildfly.log",
        3460,
        "info",
        "datasource OrdersDS re-validated database system is ready downstream",
    );

    b.incident(
        "inc1",
        "A database smart shutdown propagated through the app server (IJ000453), the worker (refused connections) and the client edge (502s) until readiness returned.",
        "established",
        &[g_trigger],
        2500,
        3520,
    );

    b.query(
        "q1",
        "broad",
        "Storefront traffic degraded — what happened across the stack?",
        plan(&["error", "refused", "502"]),
        true,
        &[
            (g_trigger, 3),
            (g_appserver, 2),
            (g_worker, 2),
            (g_client, 1),
        ],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "What started the storefront 502s?",
        plan(&["shutdown", "connection", "502"]),
        true,
        &[(g_trigger, 3), (g_appserver, 2)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the client-facing errors.",
        plan(&["502", "upstream"]),
        true,
        &[(g_client, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Trace job {job}."),
        plan(&[&job]),
        true,
        &[(g_worker, 2)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Was a bad deployment responsible?",
        plan(&["deploy", "rollback", "artifact", "failed"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Do all four services point at the same origin?",
        plan(&["shutdown", "refused", "IJ000453", "502"]),
        true,
        &[
            (g_trigger, 3),
            (g_appserver, 2),
            (g_worker, 2),
            (g_client, 1),
        ],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Order the failure and the recovery across services.",
        plan(&["ready", "shutdown", "re-validated"]),
        true,
        &[(g_trigger, 3), (g_recovery, 1)],
        &[],
    );

    b.claims(
        &[
            "the database shutdown is the earliest causal record",
            "IJ000453, worker retries, and client 502s are the same incident seen from different tiers",
            "recovery is anchored by the readiness record",
        ],
        &["the client edge caused the 502s", "the worker retry loop caused the outage"],
        &[],
        &["why the smart shutdown was requested is not in the corpus"],
    );
    b.expect_pass(0.6, 0.25);
}

// ---------------------------------------------------------------------------
// rb06 — duplicate renderings
// ---------------------------------------------------------------------------

pub const RB06: RaCaseSpec = RaCaseSpec {
    case_id: "rb06-duplicate-renderings",
    case_version: 1,
    title: "Duplicate renderings",
    intended_probe: "one failure appears as a multiline application exception plus hundreds of separately wrapped stderr records",
    day: 5,
    scale_cap: None,
    build: build_rb06,
};

fn stack_frames(token: &str) -> Vec<String> {
    vec![
        format!("at post_settlement in gateway/client.go:88 {token}"),
        "at charge in checkout/service.go:42".into(),
        "at process in worker/loop.go:311".into(),
        "Caused by: TimeoutError: upstream deadline exceeded".into(),
        "at await_response in gateway/transport.go:129".into(),
        "at flush in gateway/buffer.go:77".into(),
        "at run in runtime/task.go:19".into(),
    ]
}

fn build_rb06(b: &mut RaCaseBuilder) {
    b.source(
        "app/service.log",
        "settlement",
        "app-03.example",
        RaFormat::Plain,
    );
    b.source(
        "wrapper/service.stderr",
        "settlement-wrapper",
        "app-03.example",
        RaFormat::Plain,
    );
    b.source(
        "api/traffic.jsonl",
        "settlement-api",
        "api-04.example",
        RaFormat::Jsonl,
    );

    let txn = format!("txn-{}", b.rng.hex8_upper());
    let other = format!("txn-{}", b.rng.hex8_upper());

    b.noise("api/traffic.jsonl", 0, 3600, 300, &mut |rng, _i| {
        (
            "info",
            format!(
                "batch heartbeat ok batch=b-{} items={}",
                rng.hex8(),
                rng.next_range(60)
            ),
        )
    });
    b.noise("app/service.log", 0, 2900, 50, &mut |rng, _i| {
        (
            "info",
            format!("worker heartbeat ok lag_ms={}", rng.next_range(90)),
        )
    });

    // ONE semantic occurrence: an application full-stack rendering plus a
    // flood of separately wrapped stderr records.
    let g_failure = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        txn.clone(),
        "wall",
        3000,
        "single settlement failure rendered twice: full stack + wrapped stderr flood",
    );
    // The `Type: detail` shape is what the production exception-signature
    // extractor recognises; wrapped copies must be byte-identical to the lead
    // so both renderings share one root signature.
    let lead = format!("PaymentGatewayException: settlement post failed {txn}");
    b.gexception(
        g_failure,
        "app/service.log",
        3000,
        "error",
        &lead,
        &stack_frames(""),
    );
    // 200 wrapped records forming ONE separately-wrapped stderr rendering of
    // the same occurrence: one exception header record plus 199 wrapped stack
    // records. The shared `Caused by:` root signature is what lets the
    // production episode analysis correlate the two renderings.
    let mut wrapped = vec![lead.clone()];
    let frames = stack_frames("");
    for index in 0..199usize {
        wrapped.push(frames[1 + (index % (frames.len() - 1))].clone());
    }
    b.gstderr_wrapped(g_failure, "wrapper/service.stderr", 3001, "error", &wrapped);
    b.set_occurrences(g_failure, 1);

    // Interleaved unrelated control: a different exception that must never be
    // merged into the settlement failure.
    let g_control = b.group(
        "g02",
        RaRole::Neutral,
        None,
        other.clone(),
        "wall",
        3200,
        "unrelated exception; must remain a separate finding",
    );
    b.gexception(
        g_control,
        "app/service.log",
        3200,
        "error",
        &format!("CacheWarmupException: prefetch shard unavailable {other}"),
        &[
            "at warm in cache/prefetch.go:51".into(),
            "at run in runtime/task.go:19".into(),
        ],
    );

    b.incident(
        "inc1",
        "One settlement post failure produced an application stack trace and ~200 wrapped stderr records; it is a single semantic occurrence.",
        "established",
        &[g_failure],
        3000,
        3260,
    );

    b.query(
        "q1",
        "broad",
        "What failed in settlement processing?",
        plan(&["settlement", "failed"]),
        true,
        &[(g_failure, 3)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "What is the root failure behind the stderr noise?",
        plan(&["settlement", "post", "failed", "deadline"]),
        true,
        &[(g_failure, 3)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the gateway exception records.",
        plan(&["PaymentGatewayException"]),
        true,
        &[(g_failure, 3)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Show everything for {txn}."),
        plan(&[&txn]),
        true,
        &[(g_failure, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did the cache warmup failure break settlement?",
        plan(&["CacheWarmupException", "settlement"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Are the stderr records a second incident?",
        plan(&["stderr", "settlement", "failed"]),
        true,
        &[(g_failure, 3)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "How many distinct failures happened here?",
        plan(&["failed", "exception"]),
        true,
        &[(g_failure, 3), (g_control, 1)],
        &[],
    );

    b.claims(
        &[
            "the application stack trace and the stderr flood are renderings of one occurrence",
            "raw record volume must not be reported as occurrence count",
            "the cache warmup exception is a separate, unrelated finding",
        ],
        &[
            "roughly two hundred settlement failures occurred",
            "the stderr flood is a distinct second incident",
        ],
        &[],
        &["wrapper restart policy is not in the corpus"],
    );
    b.expect_pass(0.6, 0.3);
}

// ---------------------------------------------------------------------------
// rb07 — interleaved executions
// ---------------------------------------------------------------------------

pub const RB07: RaCaseSpec = RaCaseSpec {
    case_id: "rb07-interleaved",
    case_version: 1,
    title: "Interleaved executions",
    intended_probe: "similar exceptions from unrelated threads/requests must remain separate",
    day: 6,
    scale_cap: None,
    build: build_rb07,
};

fn build_rb07(b: &mut RaCaseBuilder) {
    b.source(
        "app/server.log",
        "order-service",
        "app-04.example",
        RaFormat::Plain,
    );
    b.source(
        "api/orders.jsonl",
        "orders-api",
        "api-05.example",
        RaFormat::Jsonl,
    );

    let txn_a = format!("txn-{}", b.rng.hex8_upper());
    let txn_b = format!("txn-{}", b.rng.hex8_upper());

    b.noise("api/orders.jsonl", 0, 3600, 380, &mut |rng, _i| {
        (
            "info",
            format!(
                "order accepted order=ord-{} lane={}",
                rng.hex8(),
                rng.next_range(4)
            ),
        )
    });
    b.noise("app/server.log", 0, 2900, 80, &mut |rng, _i| {
        (
            "info",
            format!(
                "worker heartbeat lane={} queue_depth={}",
                rng.next_range(4),
                rng.next_range(40)
            ),
        )
    });

    let g_a = b.group(
        "g01",
        RaRole::Trigger,
        Some("inca"),
        txn_a.clone(),
        "wall",
        3000,
        "thread-A null pointer on discount lookup",
    );
    let g_b = b.group(
        "g02",
        RaRole::Trigger,
        Some("incb"),
        txn_b.clone(),
        "wall",
        3001,
        "thread-B null pointer with identical frames but a different request",
    );

    // Three interleaved occurrences per thread within overlapping seconds.
    for round in 0..3i64 {
        let base = 3000 + round * 40;
        b.gexception(
            g_a,
            "app/server.log",
            base,
            "error",
            &format!("NullPointerException: discount lookup failed thread=lane-a {txn_a}"),
            &[
                "at lookup_discount in orders/discount.go:66".into(),
                "at apply in orders/pricing.go:31".into(),
            ],
        );
        b.gexception(
            g_b,
            "app/server.log",
            base + 1,
            "error",
            &format!("NullPointerException: discount lookup failed thread=lane-b {txn_b}"),
            &[
                "at lookup_discount in orders/discount.go:66".into(),
                "at apply in orders/pricing.go:31".into(),
            ],
        );
    }

    b.incident(
        "inca",
        "Thread lane-a repeatedly hit a null discount for one request.",
        "established",
        &[g_a],
        3000,
        3130,
    );
    b.incident(
        "incb",
        "Thread lane-b hit the same code path for an unrelated request.",
        "established",
        &[g_b],
        3000,
        3130,
    );

    b.query(
        "q1",
        "broad",
        "What exceptions are the order workers throwing?",
        plan(&["NullPointerException", "discount"]),
        true,
        &[(g_a, 3), (g_b, 3)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        &format!("Why did request {txn_a} fail?"),
        plan(&[&txn_a]),
        true,
        &[(g_a, 3)],
        &[g_b],
    );
    b.query(
        "q3",
        "symptom",
        "Show discount lookup failures.",
        plan(&["discount", "lookup", "failed"]),
        true,
        &[(g_a, 3), (g_b, 3)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Show everything for {txn_b}."),
        plan(&[&txn_b]),
        true,
        &[(g_b, 3)],
        &[g_a],
    );
    b.query(
        "q5",
        "negative",
        "Did the pricing database go down?",
        plan(&["pricing", "database", "down"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Are lane-a and lane-b failures one incident or two?",
        plan(&["lane-a", "lane-b", "NullPointerException"]),
        true,
        &[(g_a, 3), (g_b, 3)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Do the two threads fail at the same moments?",
        plan(&["thread", "discount", "failed"]),
        true,
        &[(g_a, 3), (g_b, 3)],
        &[],
    );

    b.claims(
        &[
            "lane-a and lane-b failures belong to different requests despite identical frames",
            "each thread shows three occurrences",
        ],
        &[
            "the six exception records are one incident",
            "lane-a caused lane-b",
        ],
        &[],
        &["whether both requests came from the same client is unknowable here"],
    );
    b.expect_pass(0.7, 0.3);
}

// ---------------------------------------------------------------------------
// rb08 — rotations, nested sources, archive parity
// ---------------------------------------------------------------------------

pub const RB08: RaCaseSpec = RaCaseSpec {
    case_id: "rb08-rotations-nested",
    case_version: 1,
    title: "Rotations and nested sources",
    intended_probe: "rotated suffixes, nested directories with shared basenames, and ZIP/folder parity keep stable source identity",
    day: 7,
    scale_cap: Some(8),
    build: build_rb08,
};

fn build_rb08(b: &mut RaCaseBuilder) {
    b.source(
        "svc/app/service.log",
        "billing",
        "billing-01.example",
        RaFormat::Plain,
    );
    b.source(
        "svc/app/service.log.1",
        "billing",
        "billing-01.example",
        RaFormat::Plain,
    );
    b.source(
        "svc/app/service.log.2025-02-14",
        "billing",
        "billing-01.example",
        RaFormat::Plain,
    );
    b.source(
        "regions/east/svc/app/service.log",
        "billing-east",
        "billing-02.example",
        RaFormat::Plain,
    );

    let cur = format!("inv-{}", b.rng.hex8_upper());
    let rot1 = format!("inv-{}", b.rng.hex8_upper());
    let dated = format!("inv-{}", b.rng.hex8_upper());
    let east = format!("inv-{}", b.rng.hex8_upper());

    // Chronology: dated segment oldest, then .1, then current; the nested
    // east region runs its own clock.
    b.noise(
        "svc/app/service.log.2025-02-14",
        0,
        900,
        90,
        &mut |rng, _i| {
            (
                "info",
                format!("invoice rendered invoice=inv-{}", rng.hex8()),
            )
        },
    );
    b.noise("svc/app/service.log.1", 1000, 1900, 120, &mut |rng, _i| {
        (
            "info",
            format!("invoice rendered invoice=inv-{}", rng.hex8()),
        )
    });
    b.noise("svc/app/service.log", 2000, 3200, 170, &mut |rng, _i| {
        (
            "info",
            format!("invoice rendered invoice=inv-{}", rng.hex8()),
        )
    });
    b.noise(
        "regions/east/svc/app/service.log",
        0,
        3200,
        120,
        &mut |rng, _i| {
            (
                "info",
                format!("invoice rendered invoice=inv-{}", rng.hex8()),
            )
        },
    );

    let g_dated = b.group(
        "g01",
        RaRole::Neutral,
        None,
        dated.clone(),
        "wall",
        500,
        "anchor in the dated rotation",
    );
    b.gevent(
        g_dated,
        "svc/app/service.log.2025-02-14",
        500,
        "warn",
        &format!("ledger drift detected during nightly close invoice={dated}"),
    );

    let g_trigger = b.group(
        "g02",
        RaRole::Trigger,
        Some("inc1"),
        rot1.clone(),
        "wall",
        1500,
        "the causal record lives in the rotated .1 segment",
    );
    b.gevent(
        g_trigger,
        "svc/app/service.log.1",
        1500,
        "error",
        &format!("ledger export wedged lock not released export={rot1}"),
    );

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        cur.clone(),
        "wall",
        2200,
        "current segment shows the stuck-export symptoms",
    );
    for offset in [2200i64, 2400, 2600] {
        b.gevent(
            g_symptom,
            "svc/app/service.log",
            offset,
            "warn",
            &format!("invoice batch delayed waiting on ledger export {cur}"),
        );
    }

    let g_east = b.group(
        "g04",
        RaRole::Neutral,
        None,
        east.clone(),
        "wall",
        1200,
        "same basename, different nested region",
    );
    b.gevent(
        g_east,
        "regions/east/svc/app/service.log",
        1200,
        "warn",
        &format!("ledger drift detected during nightly close invoice={east} region=east"),
    );

    // Mirror the whole tree into a deterministic archive: parity inside one
    // corpus, archive members keep `bundle.zip!/…` identities.
    b.zip_mirror(
        "bundle.zip",
        &[
            "svc/app/service.log",
            "svc/app/service.log.1",
            "svc/app/service.log.2025-02-14",
            "regions/east/svc/app/service.log",
        ],
    );

    b.incident(
        "inc1",
        "A wedged ledger export in the rotated segment left current-batch invoices waiting; the east region shows only routine drift.",
        "established",
        &[g_trigger],
        1500,
        2660,
    );

    b.query(
        "q1",
        "broad",
        "Why are invoice batches delayed?",
        plan(&["invoice", "delayed", "ledger"]),
        true,
        &[(g_trigger, 3), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "What is blocking the ledger export?",
        plan(&["ledger", "export", "lock"]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show delayed invoice batches.",
        plan(&["batch", "delayed", "waiting"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find export {rot1} (it may be in a rotated file)."),
        plan(&[&rot1]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Is the east region affected?",
        plan(&["region=east", "delayed"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is the nightly ledger drift the same problem as the wedged export?",
        plan(&["drift", "export", "ledger"]),
        true,
        &[(g_trigger, 3), (g_dated, 1), (g_east, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Order the rotated segments by time.",
        plan(&["ledger", "invoice"]),
        true,
        &[(g_dated, 1), (g_trigger, 3), (g_symptom, 1)],
        &[],
    );

    b.claims(
        &[
            "the causal record is in the rotated .1 segment, before the current file begins",
            "the nested east service.log is a different source than svc/app/service.log",
            "folder and archive copies carry identical content under distinct identities",
        ],
        &["the east region outage caused the delays"],
        &[],
        &["nothing in the corpus explains why the export lock was not released"],
    );
    b.expect_pass(0.6, 0.3);
}

// ---------------------------------------------------------------------------
// rb09 — time uncertainty
// ---------------------------------------------------------------------------

pub const RB09: RaCaseSpec = RaCaseSpec {
    case_id: "rb09-time-uncertainty",
    case_version: 1,
    title: "Time uncertainty",
    intended_probe: "ambiguous local time, mixed offsets, DST ambiguity and order-only records must not yield invented cross-source chronology",
    day: 8,
    scale_cap: Some(4),
    build: build_rb09,
};

fn build_rb09(b: &mut RaCaseBuilder) {
    b.source(
        "billing/api.jsonl",
        "billing-api",
        "billing-03.example",
        RaFormat::Jsonl,
    );
    b.source(
        "sched/local.jsonl",
        "scheduler",
        "sched-01.example",
        RaFormat::Jsonl,
    );
    b.source(
        "audit/steps.log",
        "audit",
        "audit-01.example",
        RaFormat::Plain,
    );

    let shared = format!("evt-{}", b.rng.hex8_upper());
    let dst = format!("evt-{}", b.rng.hex8_upper());
    let steps = format!("run-{}", b.rng.hex8_upper());

    b.noise("billing/api.jsonl", 0, 3600, 360, &mut |rng, _i| {
        (
            "info",
            format!(
                "charge posted charge=chg-{} cents={}",
                rng.hex8(),
                100 + rng.next_range(40_000)
            ),
        )
    });

    // Shared instant in three encodings (epoch, RFC3339 UTC, +01:00).
    let g_shared = b.group(
        "g01",
        RaRole::Neutral,
        None,
        shared.clone(),
        "wall",
        1800,
        "one instant, three encodings; not three events in sequence",
    );
    let instant = b.epoch + 1800;
    let utc = chrono::DateTime::from_timestamp(instant, 0)
        .expect("epoch")
        .format("%Y-%m-%dT%H:%M:%SZ");
    let plus_one = chrono::DateTime::from_timestamp(instant, 0)
        .expect("epoch")
        .with_timezone(&chrono::FixedOffset::east_opt(3600).expect("offset"))
        .format("%Y-%m-%dT%H:%M:%S%:z");
    b.gevent(
        g_shared,
        "billing/api.jsonl",
        1800,
        "info",
        &format!("settlement checkpoint reached {shared} encoding=epoch-seconds"),
    );
    b.gevent_raw(
        g_shared,
        "billing/api.jsonl",
        1800,
        "info",
        &serde_json::json!({
            "ts": utc.to_string(),
            "level": "info",
            "service": "billing-api",
            "host": "billing-03.example",
            "trace_id": "trace-shared-instant",
            "message": format!("settlement checkpoint reached {shared} encoding=rfc3339-utc")
        })
        .to_string(),
    );
    b.gevent_raw(
        g_shared,
        "billing/api.jsonl",
        1800,
        "info",
        &serde_json::json!({
            "ts": plus_one.to_string(),
            "level": "info",
            "service": "billing-api",
            "host": "billing-03.example",
            "trace_id": "trace-shared-instant",
            "message": format!("settlement checkpoint reached {shared} encoding=rfc3339-plus-one")
        })
        .to_string(),
    );
    b.set_occurrences(g_shared, 1);

    // DST-ambiguous local wall time without an offset (US fall-back hour).
    let g_dst = b.group(
        "g02",
        RaRole::Trigger,
        Some("inc1"),
        dst.clone(),
        "ambiguous_local",
        1900,
        "fall-back local time without offset: could be either UTC instant",
    );
    b.gevent_raw(
        g_dst,
        "sched/local.jsonl",
        1900,
        "warn",
        &serde_json::json!({
            "ts": "2025-11-02T01:30:00",
            "level": "warn",
            "service": "scheduler",
            "host": "sched-01.example",
            "trace_id": "trace-dst-ambiguous",
            "message": format!("nightly reconciliation started twice {dst} local fall-back hour without offset")
        })
        .to_string(),
    );

    // Order-only source: no timestamps at all.
    let g_steps = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        steps.clone(),
        "order_only",
        2000,
        "order-only records: sequence within the file is known, wall time is not",
    );
    b.emit_raw_record(
        "audit/steps.log",
        2000,
        "info",
        "step=1 reconciliation queued run pending",
    );
    b.gevent_raw(
        g_steps,
        "audit/steps.log",
        2001,
        "warn",
        &format!("step=2 duplicate reconciliation detected {steps}"),
    );
    b.emit_raw_record(
        "audit/steps.log",
        2002,
        "info",
        "step=3 duplicate suppressed run complete",
    );
    b.set_occurrences(g_steps, 1);

    b.incident(
        "inc1",
        "A reconciliation started twice during the ambiguous fall-back hour; the audit trail is order-only, so cross-source wall-clock ordering cannot be established.",
        "established",
        &[g_dst],
        1700,
        2200,
    );

    b.mixed_time_quality();

    b.query(
        "q1",
        "broad",
        "Did the nightly reconciliation misbehave?",
        plan(&["reconciliation", "duplicate"]),
        true,
        &[(g_dst, 3), (g_steps, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "Why did reconciliation run twice?",
        plan(&["reconciliation", "twice", "fall-back"]),
        true,
        &[(g_dst, 3)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show duplicate reconciliation evidence.",
        plan(&["duplicate", "reconciliation"]),
        true,
        &[(g_dst, 3), (g_steps, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find {shared} occurrences."),
        plan(&[&shared]),
        true,
        &[(g_shared, 1)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did the billing API lose charges?",
        plan(&["charge", "lost", "missing"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Could the duplicate run be a clock problem rather than a scheduler bug?",
        plan(&["clock", "fall-back", "duplicate"]),
        true,
        &[(g_dst, 3)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Exactly when did the second run start?",
        plan(&["reconciliation", "started", "twice"]),
        true,
        &[(g_dst, 3)],
        &[],
    );

    b.claims(
        &[
            "the three shared-instant encodings are one instant, not a sequence",
            "the duplicate start sits in the ambiguous fall-back hour",
            "the audit steps are ordered only relative to each other",
        ],
        &[
            "a confident cross-source wall-clock ordering of the audit steps",
            "the duplicate run started at exactly 01:30 UTC",
        ],
        &[],
        &[
            "the scheduler's zone rules are not declared in the corpus",
            "order-only evidence cannot be upgraded to calendar time",
        ],
    );
    b.expect_pass(0.5, 0.3);
}

// ---------------------------------------------------------------------------
// rb10 — competing roots
// ---------------------------------------------------------------------------

pub const RB10: RaCaseSpec = RaCaseSpec {
    case_id: "rb10-competing-roots",
    case_version: 1,
    title: "Competing roots",
    intended_probe: "two equally supported explanations must both survive retrieval and analysis",
    day: 9,
    scale_cap: None,
    build: build_rb10,
};

fn build_rb10(b: &mut RaCaseBuilder) {
    b.source(
        "config/deploy.jsonl",
        "deploy-audit",
        "control-02.example",
        RaFormat::Jsonl,
    );
    b.source(
        "cache/redis.log",
        "cache",
        "cache-02.example",
        RaFormat::Logfmt,
    );
    b.source(
        "api/service.jsonl",
        "catalog-api",
        "api-06.example",
        RaFormat::Jsonl,
    );

    let chg = format!("chg-{}", b.rng.hex8_upper());
    let evict = format!("ev-{}", b.rng.hex8_upper());
    let lat = format!("req-{}", b.rng.hex8_upper());

    b.noise("api/service.jsonl", 0, 4200, 300, &mut |rng, _i| {
        (
            "info",
            format!(
                "catalog lookup ok item=sku-{} duration_ms={}",
                rng.hex8(),
                5 + rng.next_range(40)
            ),
        )
    });
    b.noise("cache/redis.log", 0, 4200, 120, &mut |rng, _i| {
        (
            "info",
            format!(
                "keyspace sample keys={} expires={}",
                100_000 + rng.next_range(50_000),
                rng.next_range(20_000)
            ),
        )
    });

    let g_config = b.group(
        "g01",
        RaRole::Trigger,
        Some("inca"),
        chg.clone(),
        "wall",
        2500,
        "explanation A: TTL shrink deployed minutes before the latency rise",
    );
    b.gevent(
        g_config,
        "config/deploy.jsonl",
        2500,
        "warn",
        &format!("config change {chg} applied cache ttl lowered from 300s to 5s"),
    );

    let g_evict = b.group(
        "g02",
        RaRole::Trigger,
        Some("incb"),
        evict.clone(),
        "wall",
        2520,
        "explanation B: eviction storm at memory limit in the same window",
    );
    for offset in [2520i64, 2580] {
        b.gevent(
            g_evict,
            "cache/redis.log",
            offset,
            "warn",
            &format!("eviction storm memory limit reached evicted {evict} keys=18342"),
        );
    }

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        None,
        lat.clone(),
        "wall",
        2600,
        "shared symptom compatible with either explanation",
    );
    for offset in [2600i64, 2660, 2720, 2780] {
        b.gevent(
            g_symptom,
            "api/service.jsonl",
            offset,
            "error",
            &format!("catalog lookup slow cache miss duration_ms=1890 request={lat}"),
        );
    }

    b.incident(
        "inca",
        "Explanation A: the TTL shrink emptied the cache.",
        "competing",
        &[g_config],
        2500,
        2840,
    );
    b.incident(
        "incb",
        "Explanation B: the eviction storm emptied the cache.",
        "competing",
        &[g_evict],
        2500,
        2840,
    );

    b.query(
        "q1",
        "broad",
        "Why did catalog lookups slow down?",
        plan(&["catalog", "slow", "cache"]),
        true,
        &[(g_config, 3), (g_evict, 3), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "What emptied the cache?",
        plan(&["cache", "ttl", "eviction"]),
        true,
        &[(g_config, 3), (g_evict, 3)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the slow cache-miss lookups.",
        plan(&["cache", "miss", "slow"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Show change {chg}."),
        plan(&[&chg]),
        true,
        &[(g_config, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did the database slow down?",
        plan(&["database", "slow"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is the TTL change or the eviction storm the better-supported cause?",
        plan(&["ttl", "eviction", "cache"]),
        true,
        &[(g_config, 3), (g_evict, 3)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Which candidate cause appears first, and is the gap decisive?",
        plan(&["ttl", "eviction", "applied"]),
        true,
        &[(g_config, 3), (g_evict, 3)],
        &[],
    );

    b.claims(
        &[
            "both the TTL shrink and the eviction storm are supported causal candidates",
            "the 20-second gap between them is within source skew and not decisive",
        ],
        &[
            "the TTL change is confidently the root cause",
            "the eviction storm is confidently the root cause",
        ],
        &[
            "ttl shrink emptied the cache",
            "eviction storm emptied the cache",
        ],
        &["the corpus cannot break the tie between the two explanations"],
    );
    b.expect_pass(0.6, 0.3);
}
