//! Retrieval-ablation cases rb11–rb20. Same content rules as part A.

use super::super::{RaFormat, RaKeywordPlan, RaRole};
use super::RaCaseBuilder;
use super::RaCaseSpec;

fn plan(terms: &[&str]) -> RaKeywordPlan {
    RaKeywordPlan::terms_only(terms)
}

fn plan_service(terms: &[&str], services: &[&str]) -> RaKeywordPlan {
    let mut plan = RaKeywordPlan::terms_only(terms);
    plan.services = services.iter().map(|s| s.to_string()).collect();
    plan
}

// ---------------------------------------------------------------------------
// rb11 — missing trigger
// ---------------------------------------------------------------------------

pub const RB11: RaCaseSpec = RaCaseSpec {
    case_id: "rb11-missing-trigger",
    case_version: 1,
    title: "Missing trigger",
    intended_probe: "only symptoms are present; the root cause must remain unknown",
    day: 10,
    scale_cap: None,
    build: build_rb11,
};

fn build_rb11(b: &mut RaCaseBuilder) {
    b.source(
        "api/gateway.jsonl",
        "public-gateway",
        "gw-01.example",
        RaFormat::Jsonl,
    );
    b.source(
        "worker/tasks.log",
        "job-worker",
        "worker-03.example",
        RaFormat::Logfmt,
    );

    let req = format!("req-{}", b.rng.hex8_upper());
    let task = format!("wrk-{}", b.rng.hex8_upper());

    b.noise("api/gateway.jsonl", 0, 4200, 250, &mut |rng, _i| {
        (
            "info",
            format!(
                "proxied path=/v1/profile status=200 request=req-{}",
                rng.hex8()
            ),
        )
    });
    b.noise("worker/tasks.log", 0, 4200, 130, &mut |rng, _i| {
        (
            "info",
            format!("task complete task=wrk-{} attempts=1", rng.hex8()),
        )
    });

    let g_5xx = b.group(
        "g01",
        RaRole::Symptom,
        Some("inc1"),
        req.clone(),
        "wall",
        2400,
        "5xx spike with no in-corpus cause",
    );
    for offset in [2400i64, 2430, 2460, 2490] {
        b.gevent(
            g_5xx,
            "api/gateway.jsonl",
            offset,
            "error",
            &format!(
                "proxied path=/v1/profile status=503 upstream no healthy endpoints request={req}"
            ),
        );
    }

    let g_retry = b.group(
        "g02",
        RaRole::Symptom,
        Some("inc1"),
        task.clone(),
        "wall",
        2500,
        "task retries against the same unhealthy dependency",
    );
    for offset in [2500i64, 2560] {
        b.gevent(
            g_retry,
            "worker/tasks.log",
            offset,
            "warn",
            &format!("task retry scheduled dependency unhealthy task={task}"),
        );
    }

    b.incident(
        "inc1",
        "Profile traffic saw 503s and task retries against an unhealthy dependency; no in-corpus record explains why the dependency became unhealthy.",
        "unknown",
        &[],
        2400,
        2620,
    );

    b.query(
        "q1",
        "broad",
        "What went wrong with profile traffic?",
        plan(&["profile", "503", "unhealthy"]),
        true,
        &[(g_5xx, 1), (g_retry, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "What is the root cause of the 503s?",
        plan(&["503", "cause", "unhealthy"]),
        true,
        &[(g_5xx, 1), (g_retry, 1)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the failing profile requests.",
        plan(&["profile", "503"]),
        true,
        &[(g_5xx, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find request {req}."),
        plan(&[&req]),
        true,
        &[(g_5xx, 1)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did a deployment cause this?",
        plan(&["deploy", "release", "rollout"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is there any supported explanation for the dependency going unhealthy?",
        plan(&["dependency", "unhealthy", "cause"]),
        true,
        &[(g_retry, 1), (g_5xx, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Did the symptoms stop within this corpus?",
        plan(&["503", "retry", "unhealthy"]),
        true,
        &[(g_5xx, 1), (g_retry, 1)],
        &[],
    );

    b.claims(
        &[
            "the corpus contains symptoms only",
            "the root cause is not establishable from this corpus",
        ],
        &[
            "a specific root cause is established",
            "the dependency failure originated inside the gateway",
        ],
        &[],
        &["root cause unknown is the only supportable conclusion"],
    );
    b.expect_pass(0.5, 0.3);
}

// ---------------------------------------------------------------------------
// rb12 — semantic near-miss
// ---------------------------------------------------------------------------

pub const RB12: RaCaseSpec = RaCaseSpec {
    case_id: "rb12-semantic-near-miss",
    case_version: 1,
    title: "Semantic near-miss",
    intended_probe: "highly similar messages belong to different services and incidents; embeddings must not merge them",
    day: 11,
    scale_cap: None,
    build: build_rb12,
};

fn build_rb12(b: &mut RaCaseBuilder) {
    b.source(
        "payments/api.jsonl",
        "payments-api",
        "pay-01.example",
        RaFormat::Jsonl,
    );
    b.source(
        "payouts/api.jsonl",
        "payouts-api",
        "payout-01.example",
        RaFormat::Jsonl,
    );

    let pay_batch = format!("batch-{}", b.rng.hex8_upper());
    let payout_batch = format!("batch-{}", b.rng.hex8_upper());
    let shard = format!("shard-{}", b.rng.hex8_upper());

    b.noise("payments/api.jsonl", 0, 4200, 240, &mut |rng, _i| {
        (
            "info",
            format!(
                "ledger sync ok batch=batch-{} items={}",
                rng.hex8(),
                rng.next_range(200)
            ),
        )
    });
    b.noise("payouts/api.jsonl", 0, 4200, 190, &mut |rng, _i| {
        (
            "info",
            format!(
                "ledger sync ok batch=batch-{} items={}",
                rng.hex8(),
                rng.next_range(80)
            ),
        )
    });

    let g_pay_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inca"),
        shard.clone(),
        "wall",
        2000,
        "payments-side stall is the cause of the payments incident",
    );
    b.gevent(
        g_pay_trigger,
        "payments/api.jsonl",
        2000,
        "error",
        &format!("settlement processor stalled {shard} queue drain halted"),
    );

    let g_pay_symptom = b.group(
        "g02",
        RaRole::Symptom,
        Some("inca"),
        pay_batch.clone(),
        "wall",
        2100,
        "payments settlement timeouts",
    );
    for offset in [2100i64, 2160, 2220] {
        b.gevent(
            g_pay_symptom,
            "payments/api.jsonl",
            offset,
            "error",
            &format!("settlement batch timeout {pay_batch} after 30000ms"),
        );
    }

    // Near-identical wording, different service, different (minor) incident,
    // later window.
    let g_payout = b.group(
        "g03",
        RaRole::Neutral,
        Some("incb"),
        payout_batch.clone(),
        "wall",
        3600,
        "payouts settlement timeout during announced provider maintenance — unrelated to payments",
    );
    b.gevent(
        g_payout,
        "payouts/api.jsonl",
        3600,
        "warn",
        &format!("settlement batch timeout {payout_batch} after 30000ms provider maintenance window announced"),
    );

    b.incident(
        "inca",
        "Payments settlements timed out behind a stalled processor shard.",
        "established",
        &[g_pay_trigger],
        2000,
        2280,
    );
    b.incident(
        "incb",
        "A payouts settlement timed out during announced provider maintenance.",
        "established",
        &[g_payout],
        3600,
        3660,
    );

    b.query(
        "q1",
        "broad",
        "What is failing in payment processing?",
        plan_service(&["settlement", "timeout", "stalled"], &["payments-api"]),
        true,
        &[(g_pay_trigger, 3), (g_pay_symptom, 1)],
        &[g_payout],
    );
    b.query(
        "q2",
        "causal",
        "Why are payments settlements timing out?",
        plan_service(&["settlement", "timeout", "stalled"], &["payments-api"]),
        true,
        &[(g_pay_trigger, 3), (g_pay_symptom, 1)],
        &[g_payout],
    );
    b.query(
        "q3",
        "symptom",
        "Show payments settlement timeouts.",
        plan_service(&["settlement", "batch", "timeout"], &["payments-api"]),
        true,
        &[(g_pay_symptom, 1)],
        &[g_payout],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find {pay_batch}."),
        plan(&[&pay_batch]),
        true,
        &[(g_pay_symptom, 1)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Are payout settlements part of the payments incident?",
        plan(&["payouts", "incident"]),
        false,
        &[],
        &[g_payout],
    );
    b.query(
        "q6",
        "competing",
        "Could the payouts timeout explain the payments timeouts?",
        plan(&["settlement", "timeout", "maintenance"]),
        true,
        &[(g_pay_trigger, 3), (g_payout, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Did the payments incident end before the payouts event?",
        plan(&["settlement", "stalled", "maintenance"]),
        true,
        &[(g_pay_trigger, 3), (g_payout, 1)],
        &[],
    );

    b.claims(
        &[
            "the payments and payouts timeouts are different incidents in different services",
            "the payouts event has its own benign explanation",
        ],
        &[
            "the payouts maintenance caused the payments timeouts",
            "one merged settlement incident spans both services",
        ],
        &[],
        &["nothing links the two services in this corpus"],
    );
    b.expect_pass(0.7, 0.25);
}

// ---------------------------------------------------------------------------
// rb13 — multilingual / paraphrased evidence
// ---------------------------------------------------------------------------

pub const RB13: RaCaseSpec = RaCaseSpec {
    case_id: "rb13-multilingual",
    case_version: 1,
    title: "Multilingual and paraphrased evidence",
    intended_probe: "terminology-varied and non-English records measure multilingual retrieval without making language the answer",
    day: 12,
    scale_cap: None,
    build: build_rb13,
};

fn build_rb13(b: &mut RaCaseBuilder) {
    b.source(
        "app/global.jsonl",
        "intl-orders",
        "intl-01.example",
        RaFormat::Jsonl,
    );

    let txn = format!("txn-{}", b.rng.hex8_upper());
    let conn = format!("conn-{}", b.rng.hex8_upper());
    let retry = format!("retry-{}", b.rng.hex8_upper());
    let back = format!("evt-{}", b.rng.hex8_upper());

    b.noise("app/global.jsonl", 0, 4200, 420, &mut |rng, _i| {
        (
            "info",
            format!(
                "order routed market=eu-{} order=ord-{}",
                rng.next_range(9),
                rng.hex8()
            ),
        )
    });

    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        conn.clone(),
        "wall",
        2300,
        "trigger logged in German",
    );
    b.gevent(
        g_trigger,
        "app/global.jsonl",
        2300,
        "error",
        &format!("Verbindung zum Bestellspeicher verloren {conn} Wiederherstellung angefordert"),
    );

    let g_prop = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        retry.clone(),
        "wall",
        2360,
        "propagation logged in Spanish",
    );
    for offset in [2360i64, 2420] {
        b.gevent(
            g_prop,
            "app/global.jsonl",
            offset,
            "warn",
            &format!("reintento de escritura fallido almacén de pedidos {retry}"),
        );
    }

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        txn.clone(),
        "wall",
        2480,
        "symptom logged in English",
    );
    for offset in [2480i64, 2540] {
        b.gevent(
            g_symptom,
            "app/global.jsonl",
            offset,
            "error",
            &format!("checkout request failed order store unavailable {txn}"),
        );
    }

    let g_recovery = b.group(
        "g04",
        RaRole::Recovery,
        Some("inc1"),
        back.clone(),
        "wall",
        3000,
        "recovery logged in French",
    );
    b.gevent(
        g_recovery,
        "app/global.jsonl",
        3000,
        "info",
        &format!("connexion au magasin de commandes rétablie {back}"),
    );

    b.incident(
        "inc1",
        "The order store connection dropped (logged in German), writes retried (Spanish), checkouts failed (English), and the connection was restored (French). One incident; language is surface only.",
        "established",
        &[g_trigger],
        2300,
        3060,
    );

    b.query(
        "q1",
        "broad",
        "What happened to international orders?",
        plan(&["order", "failed", "unavailable"]),
        true,
        &[(g_trigger, 3), (g_prop, 2), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "Why did checkouts lose the order store?",
        plan(&["order", "store", "lost", "connection"]),
        true,
        &[(g_trigger, 3), (g_prop, 2)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the failed checkout requests.",
        plan(&["checkout", "failed"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find {conn}."),
        plan(&[&conn]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Was this a payment provider outage?",
        plan(&["payment", "provider", "outage"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is there more than one explanation for the checkout failures?",
        plan(&["checkout", "failed", "store"]),
        true,
        &[(g_trigger, 3), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "When was the connection restored?",
        plan(&["restored", "recovered", "connection"]),
        true,
        &[(g_recovery, 1), (g_trigger, 3)],
        &[],
    );

    b.claims(
        &[
            "the German-language record is the earliest causal evidence",
            "all four languages describe one incident",
        ],
        &["four separate incidents occurred, one per language"],
        &[],
        &["translation is a presentation concern; identifiers are language-neutral"],
    );
    b.expect_limitation(
        "the trigger/propagation/recovery evidence is logged in German/Spanish/French; English keyword plans reach them only via identifiers",
        &["q2", "q7"],
        None,
        Some(0.4),
    );
}

// ---------------------------------------------------------------------------
// rb14 — secrets and malformed input
// ---------------------------------------------------------------------------

pub const RB14: RaCaseSpec = RaCaseSpec {
    case_id: "rb14-secrets-malformed",
    case_version: 1,
    title: "Secrets and malformed input",
    intended_probe:
        "credential-shaped values, malformed Unicode, binary noise and markup distractions",
    day: 13,
    scale_cap: Some(8),
    build: build_rb14,
};

fn build_rb14(b: &mut RaCaseBuilder) {
    b.source(
        "app/datasource.log",
        "orders-app",
        "app-05.example",
        RaFormat::Logfmt,
    );
    b.source(
        "auth/tokens.jsonl",
        "token-service",
        "auth-02.example",
        RaFormat::Jsonl,
    );

    let kid = format!("kid-{}", b.rng.hex8_upper());
    let ds = format!("ds-{}", b.rng.hex8_upper());
    let password = format!("LOG-LAB-INVALID-{}", b.rng.hex8_upper());
    let api_key = format!("sk-LOG-LAB-INVALID-{}", b.rng.hex8_upper());

    b.noise("app/datasource.log", 0, 3600, 260, &mut |rng, _i| {
        (
            "info",
            format!(
                "datasource checkout ok pool=main waited_ms={}",
                rng.next_range(20)
            ),
        )
    });
    b.noise("auth/tokens.jsonl", 0, 3600, 140, &mut |rng, _i| {
        (
            "info",
            format!("token issued subject=svc-{} ttl=3600", rng.hex8()),
        )
    });

    // Connection string with an embedded credential-shaped value. The value
    // carries LOG-LAB-INVALID and is registered as a secret token: it must
    // never surface in retrieved context.
    let g_ds = b.group(
        "g01",
        RaRole::Neutral,
        None,
        ds.clone(),
        "wall",
        1200,
        "datasource URL with an embedded credential-shaped value (redaction probe)",
    );
    b.gevent(
        g_ds,
        "app/datasource.log",
        1200,
        "info",
        &format!("datasource registered {ds} url=jdbc:postgresql://db-01.example:5432/orders?user=svc_orders&password={password}"),
    );
    b.secret(password.clone());
    b.secret(api_key.clone());

    let g_trigger = b.group(
        "g02",
        RaRole::Trigger,
        Some("inc1"),
        kid.clone(),
        "wall",
        2000,
        "signing key rotated; old key id keeps arriving",
    );
    b.gevent(
        g_trigger,
        "auth/tokens.jsonl",
        2000,
        "warn",
        &format!("signing key rotated new key {kid} previous key retired"),
    );

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        "signature rejected".into(),
        "wall",
        2100,
        "verification failures after the rotation",
    );
    for offset in [2100i64, 2160, 2220] {
        b.gevent(
            g_symptom,
            "auth/tokens.jsonl",
            offset,
            "error",
            &format!("token verification failed signature rejected stale key id api_key={api_key}"),
        );
    }

    // Malformed UTF-8: the reviewed production import rejects the whole file
    // as a unit (pinned observed behaviour) — sibling files are unaffected.
    let near = format!("near-{}", b.rng.hex8_upper());
    let mut malformed = Vec::new();
    malformed.extend_from_slice(
        format!("2025-02-19T21:00:00.000Z INFO import probe started {near}\n").as_bytes(),
    );
    malformed.extend_from_slice(b"\xFF\xFE\x00garbled segment one\n");
    malformed.extend_from_slice(
        format!("2025-02-19T21:00:01.000Z WARN parser survived adjacent garbage {near}\n")
            .as_bytes(),
    );
    malformed.extend_from_slice(b"\xC3\x28 invalid continuation \x80\n");
    malformed.extend_from_slice(
        format!("2025-02-19T21:00:02.000Z INFO import probe finished {near}\n").as_bytes(),
    );
    b.raw_source("garbled/malformed.log", malformed, 0, &[], true);
    b.exclude(
        "garbled/malformed.log",
        "invalid UTF-8 makes the reviewed import reject the file as a unit; valid sibling files still import",
    );

    // Binary and markup noise: expected to be excluded, never events.
    let binary: Vec<u8> = (0u16..512)
        .flat_map(|v| [(v % 251) as u8, 0x00, 0xD8, (v % 13) as u8])
        .collect();
    b.raw_source("noise/binary.log", binary, 0, &[], true);
    b.raw_source(
        "markup/export.xml",
        b"<?xml version=\"1.0\"?>\n<export>\n  <row id=\"1\">not a log</row>\n  <row id=\"2\">still not a log</row>\n</export>\n".to_vec(),
        0,
        &[],
        true,
    );
    b.exclude(
        "noise/binary.log",
        "binary bytes are unsupported input, not events",
    );
    b.exclude(
        "markup/export.xml",
        "markup export is a distraction, not a log",
    );

    b.incident(
        "inc1",
        "A signing-key rotation left clients presenting a stale key id; verification failures followed. The datasource URL credential and api_key values are synthetic secrets that must stay redacted.",
        "established",
        &[g_trigger],
        2000,
        2280,
    );

    b.query(
        "q1",
        "broad",
        "What is failing in the token service?",
        plan(&["token", "verification", "failed"]),
        true,
        &[(g_trigger, 3), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "Why are token verifications failing?",
        plan(&["signing", "key", "rotated", "stale"]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show rejected signatures.",
        plan(&["signature", "rejected"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find key {kid}."),
        plan(&[&kid]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did the database credentials expire?",
        plan(&["credential", "expired", "database"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is the datasource registration related to the verification failures?",
        plan(&["datasource", "registered", "verification"]),
        true,
        &[(g_trigger, 3), (g_ds, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Did the rotation precede the failures?",
        plan(&["rotated", "rejected"]),
        true,
        &[(g_trigger, 3), (g_symptom, 1)],
        &[],
    );

    b.claims(
        &[
            "the key rotation precedes every verification failure",
            "the malformed file is rejected as a unit without corrupting sibling sources",
            "credential-shaped values are synthetic and must remain redacted",
        ],
        &["the datasource password caused the failures"],
        &[],
        &["client-side key caching behaviour is not in the corpus"],
    );
    b.expect_pass(0.6, 0.3);
}

// ---------------------------------------------------------------------------
// rb15 — recovery evidence
// ---------------------------------------------------------------------------

pub const RB15: RaCaseSpec = RaCaseSpec {
    case_id: "rb15-recovery-evidence",
    case_version: 1,
    title: "Recovery evidence",
    intended_probe: "startup/ready/recovery records follow failures; trigger, propagation, symptom and recovery must stay distinct",
    day: 14,
    scale_cap: None,
    build: build_rb15,
};

fn build_rb15(b: &mut RaCaseBuilder) {
    b.source(
        "db/cluster.log",
        "orders-cluster",
        "db-04.example",
        RaFormat::Logfmt,
    );
    b.source(
        "api/store.jsonl",
        "store-api",
        "api-07.example",
        RaFormat::Jsonl,
    );

    let fence = format!("node-{}", b.rng.hex8_upper());
    let promo = format!("promo-{}", b.rng.hex8_upper());
    let req = format!("req-{}", b.rng.hex8_upper());

    b.noise("api/store.jsonl", 0, 4200, 260, &mut |rng, _i| {
        (
            "info",
            format!(
                "store read ok key=k-{} ms={}",
                rng.hex8(),
                1 + rng.next_range(9)
            ),
        )
    });
    b.noise("db/cluster.log", 0, 4200, 120, &mut |rng, _i| {
        (
            "info",
            format!(
                "heartbeat ok term={} lag_ms={}",
                40 + rng.next_range(3),
                rng.next_range(50)
            ),
        )
    });

    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        fence.clone(),
        "wall",
        2400,
        "primary fenced; failover initiated",
    );
    b.gevent(
        g_trigger,
        "db/cluster.log",
        2400,
        "error",
        &format!("failover initiated primary fenced {fence} quorum retained"),
    );

    let g_prop = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        promo.clone(),
        "wall",
        2460,
        "replica promotion under way",
    );
    b.gevent(
        g_prop,
        "db/cluster.log",
        2460,
        "warn",
        &format!("replica promotion in progress {promo} draining sessions"),
    );

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        req.clone(),
        "wall",
        2520,
        "writes fail during promotion",
    );
    for offset in [2520i64, 2560, 2600] {
        b.gevent(
            g_symptom,
            "api/store.jsonl",
            offset,
            "error",
            &format!("store write failed leader unavailable request={req}"),
        );
    }

    let g_recovery = b.group(
        "g04",
        RaRole::Recovery,
        Some("inc1"),
        "replication caught up".into(),
        "wall",
        3000,
        "explicit multi-record recovery sequence",
    );
    b.gevent(
        g_recovery,
        "db/cluster.log",
        3000,
        "info",
        "standby promoted accepting connections replication caught up pending",
    );
    b.gevent(
        g_recovery,
        "db/cluster.log",
        3060,
        "info",
        "replication caught up lag_ms=0",
    );
    b.gevent(
        g_recovery,
        "api/store.jsonl",
        3120,
        "info",
        "store write latency normalized replication caught up upstream",
    );

    b.incident(
        "inc1",
        "A fenced primary triggered failover; writes failed during promotion and recovered once replication caught up.",
        "established",
        &[g_trigger],
        2400,
        3180,
    );

    b.query(
        "q1",
        "broad",
        "What happened to the store tier?",
        plan(&["store", "failed", "failover"]),
        true,
        &[(g_trigger, 3), (g_prop, 2), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "Why did store writes fail?",
        plan(&["failover", "fenced", "leader"]),
        true,
        &[(g_trigger, 3), (g_prop, 2)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show failed store writes.",
        plan(&["write", "failed", "leader"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Show promotion {promo}."),
        plan(&[&promo]),
        true,
        &[(g_prop, 2)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Was quorum lost?",
        plan(&["quorum", "lost"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Did anything besides the fencing explain the failed writes?",
        plan(&["fenced", "failover", "write", "failed"]),
        true,
        &[(g_trigger, 3), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "When did the system recover, and how do we know?",
        plan(&["caught", "up", "normalized", "promoted"]),
        true,
        &[(g_recovery, 1), (g_trigger, 3)],
        &[],
    );

    b.claims(
        &[
            "the fencing record is the trigger; the promotion records are propagation",
            "the recovery sequence (promoted, caught up, normalized) closes the incident",
            "recovery records must not be classified as the trigger",
        ],
        &["the recovery promotion caused the write failures"],
        &[],
        &["why the primary was fenced is not recorded"],
    );
    b.expect_pass(0.6, 0.25);
}

// ---------------------------------------------------------------------------
// rb16 — tool-search non-progress
// ---------------------------------------------------------------------------

pub const RB16: RaCaseSpec = RaCaseSpec {
    case_id: "rb16-search-non-progress",
    case_version: 1,
    title: "Tool-search non-progress",
    intended_probe: "cosmetically different but equivalent searches must return identical evidence; workflows must change strategy or stop",
    day: 15,
    scale_cap: Some(4),
    build: build_rb16,
};

fn build_rb16(b: &mut RaCaseBuilder) {
    b.source(
        "api/search.jsonl",
        "quota-service",
        "quota-01.example",
        RaFormat::Jsonl,
    );

    let tenant = format!("tn-{}", b.rng.hex8_upper());

    b.noise("api/search.jsonl", 0, 3600, 320, &mut |rng, i| {
        if i % 7 == 0 {
            (
                "warn",
                format!(
                    "rate limit approached tenant=tn-{} used_pct={}",
                    rng.hex8(),
                    80 + rng.next_range(15)
                ),
            )
        } else {
            (
                "info",
                format!("capacity check passed tenant=tn-{}", rng.hex8()),
            )
        }
    });

    let g_exceeded = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        tenant.clone(),
        "wall",
        2400,
        "the only quota-exceeded evidence in the corpus",
    );
    for offset in [2400i64, 2460, 2520] {
        b.gevent(
            g_exceeded,
            "api/search.jsonl",
            offset,
            "error",
            &format!("quota exceeded for tenant {tenant} request rejected"),
        );
    }
    let limiter = format!("lmt-{}", b.rng.hex8_upper());
    let g_limiter = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        limiter.clone(),
        "wall",
        2580,
        "limiter engagement for the offending tenant",
    );
    b.gevent(
        g_limiter,
        "api/search.jsonl",
        2580,
        "warn",
        &format!("quota limiter engaged limiter={limiter} shedding load for the offending tenant"),
    );

    b.incident("inc1", "One tenant exhausted its quota; the limiter engaged. Re-phrasing the same search yields no new evidence.", "established", &[g_exceeded], 2400, 2640);

    b.query(
        "q1",
        "broad",
        "Are any tenants hitting quota problems?",
        plan(&["quota", "exceeded", "limiter"]),
        true,
        &[(g_exceeded, 3), (g_limiter, 2)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "Why were requests rejected?",
        plan(&["quota", "exceeded", "rejected"]),
        true,
        &[(g_exceeded, 3)],
        &[],
    );
    // Cosmetic variants of q2: same intent, whitespace/case edits only. The
    // engine must return the identical evidence set for all three.
    b.query(
        "q2b",
        "causal",
        "Why  were requests   rejected?",
        plan(&["QUOTA", "Exceeded", "REJECTED"]),
        true,
        &[(g_exceeded, 3)],
        &[],
    );
    b.query(
        "q2c",
        "causal",
        "why were requests rejected ?",
        plan(&["rejected", "exceeded", "quota"]),
        true,
        &[(g_exceeded, 3)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show rejected requests.",
        plan(&["rejected", "quota"]),
        true,
        &[(g_exceeded, 3)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Show tenant {tenant}."),
        plan(&[&tenant]),
        true,
        &[(g_exceeded, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did the quota database fail?",
        plan(&["quota", "database", "crash"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is load shedding a second incident?",
        plan(&["shedding", "limiter", "quota"]),
        true,
        &[(g_limiter, 2), (g_exceeded, 3)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "What engaged first, rejection or shedding?",
        plan(&["exceeded", "engaged"]),
        true,
        &[(g_exceeded, 3), (g_limiter, 2)],
        &[],
    );

    b.claims(
        &[
            "equivalent searches with cosmetic argument changes return identical evidence",
            "one tenant is responsible for every quota-exceeded record",
        ],
        &["repeating an equivalent search constitutes investigation progress"],
        &[],
        &["per-tenant quota configuration values are not in the corpus"],
    );
    b.expect_pass(0.7, 0.25);
}

// ---------------------------------------------------------------------------
// rb17 — rate-limit / provider interruption
// ---------------------------------------------------------------------------

pub const RB17: RaCaseSpec = RaCaseSpec {
    case_id: "rb17-provider-interruption",
    case_version: 1,
    title: "Rate-limit and provider interruption",
    intended_probe:
        "retrieval quality stays distinct from transport failure and semantic-attempt failure",
    day: 16,
    scale_cap: Some(4),
    build: build_rb17,
};

fn build_rb17(b: &mut RaCaseBuilder) {
    b.source(
        "api/payments.jsonl",
        "payments-edge",
        "pay-02.example",
        RaFormat::Jsonl,
    );

    let notice = format!("ntc-{}", b.rng.hex8_upper());
    let burst = format!("req-{}", b.rng.hex8_upper());

    b.noise("api/payments.jsonl", 0, 3600, 300, &mut |rng, _i| {
        (
            "info",
            format!(
                "payment captured payment=pmt-{} cents={}",
                rng.hex8(),
                200 + rng.next_range(80_000)
            ),
        )
    });

    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        notice.clone(),
        "wall",
        2200,
        "provider maintenance notice precedes throttling",
    );
    b.gevent(
        g_trigger,
        "api/payments.jsonl",
        2200,
        "warn",
        &format!("provider maintenance notice received {notice} throttle expected"),
    );

    let g_symptom = b.group(
        "g02",
        RaRole::Symptom,
        Some("inc1"),
        burst.clone(),
        "wall",
        2300,
        "429 burst during the provider window",
    );
    for offset in [2300i64, 2340, 2380, 2420] {
        b.gevent(
            g_symptom,
            "api/payments.jsonl",
            offset,
            "error",
            &format!("payment authorize returned 429 too many requests request={burst}"),
        );
    }

    let g_recovery = b.group(
        "g03",
        RaRole::Recovery,
        Some("inc1"),
        "throttle lifted".into(),
        "wall",
        2900,
        "provider lifts the throttle",
    );
    b.gevent(
        g_recovery,
        "api/payments.jsonl",
        2900,
        "info",
        "provider throttle lifted authorization latency normal",
    );

    b.incident("inc1", "An announced provider maintenance window throttled authorizations (429s) until the throttle lifted.", "established", &[g_trigger], 2200, 2960);

    b.query(
        "q1",
        "broad",
        "Why are payments degraded?",
        plan(&["payment", "429", "throttle"]),
        true,
        &[(g_trigger, 3), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "What caused the 429 burst?",
        plan(&["429", "maintenance", "throttle"]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the 429 responses.",
        plan(&["429", "requests"]),
        true,
        &[(g_symptom, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find notice {notice}."),
        plan(&[&notice]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did our edge crash?",
        plan(&["crash", "panic", "edge"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is the burst self-inflicted load or provider throttling?",
        plan(&["throttle", "maintenance", "429"]),
        true,
        &[(g_trigger, 3), (g_symptom, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "When did authorization latency normalize?",
        plan(&["lifted", "normal"]),
        true,
        &[(g_recovery, 1), (g_trigger, 3)],
        &[],
    );

    b.claims(
        &[
            "the maintenance notice precedes the 429 burst",
            "a transport-layer interruption of an analysis provider is never evidence about this corpus",
            "retrieval metrics must be reported separately from any provider transport status",
        ],
        &["the 429 burst indicates an edge crash"],
        &[],
        &["provider-side capacity details are not in the corpus"],
    );
    b.expect_pass(0.7, 0.25);
}

// ---------------------------------------------------------------------------
// rb18 — generic-template heterogeneity
// ---------------------------------------------------------------------------

pub const RB18: RaCaseSpec = RaCaseSpec {
    case_id: "rb18-template-heterogeneity",
    case_version: 1,
    title: "Generic-template heterogeneity",
    intended_probe: "rare operationally material events share one wildcard-heavy template with repetitive noise and must remain retrievable",
    day: 17,
    scale_cap: None,
    build: build_rb18,
};

fn build_rb18(b: &mut RaCaseBuilder) {
    b.source(
        "queue/depth.jsonl",
        "queue-monitor",
        "queue-02.example",
        RaFormat::Jsonl,
    );
    b.source(
        "queue/redrive.jsonl",
        "queue-redrive",
        "queue-02.example",
        RaFormat::Jsonl,
    );

    let spikes = [
        (2400i64, 98_421u64, format!("smp-{}", b.rng.hex8_upper())),
        (2460, 99_870, format!("smp-{}", b.rng.hex8_upper())),
        (2520, 99_112, format!("smp-{}", b.rng.hex8_upper())),
        (2580, 98_907, format!("smp-{}", b.rng.hex8_upper())),
    ];
    let redrive = format!("rd-{}", b.rng.hex8_upper());

    // The dominant wildcard family: same template, boring depths.
    b.noise("queue/depth.jsonl", 0, 5400, 760, &mut |rng, _i| {
        (
            "info",
            format!(
                "queue depth sample queue=orders-main depth={} sample=smp-{}",
                rng.next_range(120),
                rng.hex8()
            ),
        )
    });

    // Four rare, materially different records inside the SAME template family
    // (depth five orders of magnitude larger).
    let mut spike_handles = Vec::new();
    for (index, (offset, depth, token)) in spikes.iter().enumerate() {
        let handle = b.group(
            &format!("g0{}", index + 1),
            RaRole::Symptom,
            Some("inc1"),
            token.clone(),
            "wall",
            *offset,
            "rare material sample sharing the wildcard template",
        );
        b.gevent(
            handle,
            "queue/depth.jsonl",
            *offset,
            "info",
            &format!("queue depth sample queue=orders-main depth={depth} sample={token}"),
        );
        spike_handles.push(handle);
    }

    let g_redrive = b.group(
        "g05",
        RaRole::Trigger,
        Some("inc1"),
        redrive.clone(),
        "wall",
        2350,
        "the redrive that flooded the main queue",
    );
    for offset in [2350i64, 2650] {
        b.gevent(
            g_redrive,
            "queue/redrive.jsonl",
            offset,
            "warn",
            &format!("queue redrive triggered queue=orders-dlq messages=18342 redrive={redrive}"),
        );
    }

    b.incident(
        "inc1",
        "A dead-letter redrive flooded orders-main; four depth samples record the backlog inside the otherwise-boring wildcard template.",
        "established",
        &[g_redrive],
        2350,
        2700,
    );

    let all_spikes: Vec<(super::RaGroupHandle, u8)> =
        spike_handles.iter().map(|h| (*h, 1)).collect();
    b.query(
        "q1",
        "broad",
        "Is the orders queue healthy?",
        plan(&["queue", "depth", "redrive"]),
        true,
        &{
            let mut v = vec![(g_redrive, 3)];
            v.extend(all_spikes.iter().copied());
            v
        },
        &[],
    );
    b.query(
        "q2",
        "causal",
        "What flooded the orders queue?",
        plan(&["redrive", "queue", "messages"]),
        true,
        &[(g_redrive, 3)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the abnormal queue depth samples.",
        plan(&["depth", "queue", "sample"]),
        true,
        &all_spikes,
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find sample {}.", spikes[0].2),
        plan(&[&spikes[0].2]),
        true,
        &[(spike_handles[0], 1)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did consumers crash?",
        plan(&["consumer", "crash", "panic"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is the backlog organic load or the redrive?",
        plan(&["redrive", "depth", "orders-dlq"]),
        true,
        &[(g_redrive, 3)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Did the backlog start before or after the redrive?",
        plan(&["redrive", "depth"]),
        true,
        &{
            let mut v = vec![(g_redrive, 3)];
            v.push(all_spikes[0]);
            v
        },
        &[],
    );

    b.claims(
        &[
            "the four extreme depth samples are materially different from their template siblings",
            "whole-template dismissal of the depth family would hide the backlog evidence",
            "the redrive precedes the extreme samples",
        ],
        &["queue depth sampling noise constitutes the incident"],
        &[],
        &["consumer throughput limits are not in the corpus"],
    );
    b.expect_limitation(
        "the material depth samples share the wildcard template and its vocabulary; broad depth queries drown them in chronological noise. They stay reachable via identifiers and the redrive vocabulary",
        &["q3"],
        None,
        Some(0.6),
    );
}

// ---------------------------------------------------------------------------
// rb19 — high-severity isolated event
// ---------------------------------------------------------------------------

pub const RB19: RaCaseSpec = RaCaseSpec {
    case_id: "rb19-severity-isolated",
    case_version: 1,
    title: "High-severity isolated event",
    intended_probe: "a dramatic FATAL record unrelated to the incident must not outrank a supported causal chain",
    day: 18,
    scale_cap: None,
    build: build_rb19,
};

fn build_rb19(b: &mut RaCaseBuilder) {
    b.source(
        "infra/agent.log",
        "host-agent",
        "infra-01.example",
        RaFormat::Plain,
    );
    b.source(
        "api/checkout.jsonl",
        "checkout-api",
        "api-08.example",
        RaFormat::Jsonl,
    );

    let cert = format!("cert-{}", b.rng.hex8_upper());
    let req = format!("req-{}", b.rng.hex8_upper());

    b.noise("api/checkout.jsonl", 0, 4200, 320, &mut |rng, _i| {
        (
            "info",
            format!(
                "checkout ok order=ord-{} ms={}",
                rng.hex8(),
                60 + rng.next_range(200)
            ),
        )
    });
    b.noise("infra/agent.log", 0, 4200, 90, &mut |rng, _i| {
        (
            "info",
            format!("telemetry flush ok points={}", rng.next_range(4_000)),
        )
    });

    // The dramatic but unrelated FATAL.
    let g_fatal = b.group(
        "g00",
        RaRole::Decoy,
        None,
        "watchdog unrecoverable".into(),
        "wall",
        600,
        "isolated FATAL on an unrelated host agent, hours before the incident",
    );
    b.gevent(
        g_fatal,
        "infra/agent.log",
        600,
        "fatal",
        "watchdog unrecoverable condition detected core dumped pid=4471 restarting host agent",
    );

    let g_trigger = b.group(
        "g01",
        RaRole::Trigger,
        Some("inc1"),
        cert.clone(),
        "wall",
        3000,
        "expired provider certificate",
    );
    b.gevent(
        g_trigger,
        "api/checkout.jsonl",
        3000,
        "error",
        &format!("payment provider certificate expired {cert} handshake refused"),
    );

    let retry = format!("rty-{}", b.rng.hex8_upper());
    let g_prop = b.group(
        "g02",
        RaRole::Propagation,
        Some("inc1"),
        retry.clone(),
        "wall",
        3060,
        "retries against the refused handshake",
    );
    for offset in [3060i64, 3120] {
        b.gevent(
            g_prop,
            "api/checkout.jsonl",
            offset,
            "warn",
            &format!("payment retry scheduled provider handshake refused {retry}"),
        );
    }

    let g_symptom = b.group(
        "g03",
        RaRole::Symptom,
        Some("inc1"),
        req.clone(),
        "wall",
        3180,
        "checkout failures",
    );
    for offset in [3180i64, 3240, 3300] {
        b.gevent(
            g_symptom,
            "api/checkout.jsonl",
            offset,
            "error",
            &format!("checkout failed payment declined request={req}"),
        );
    }

    b.incident(
        "inc1",
        "An expired provider certificate refused handshakes; checkouts failed after retries. The infra FATAL is unrelated to this incident.",
        "established",
        &[g_trigger],
        3000,
        3360,
    );

    b.query(
        "q1",
        "broad",
        "Why are checkouts failing?",
        plan(&["checkout", "failed", "payment"]),
        true,
        &[(g_trigger, 3), (g_prop, 2), (g_symptom, 1)],
        &[g_fatal],
    );
    b.query(
        "q2",
        "causal",
        "What caused the checkout failures?",
        plan(&["certificate", "expired", "handshake"]),
        true,
        &[(g_trigger, 3), (g_prop, 2)],
        &[g_fatal],
    );
    b.query(
        "q3",
        "symptom",
        "Show failed checkouts.",
        plan(&["checkout", "failed", "declined"]),
        true,
        &[(g_symptom, 1)],
        &[g_fatal],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find {cert}."),
        plan(&[&cert]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Did the host watchdog crash cause the checkout failures?",
        plan(&["watchdog", "checkout", "failed"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Is the watchdog FATAL or the certificate the better explanation?",
        plan(&["watchdog", "certificate", "expired"]),
        true,
        &[(g_trigger, 3)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "Does the FATAL line up with the checkout failures in time?",
        plan(&["watchdog", "checkout", "certificate"]),
        true,
        &[(g_trigger, 3)],
        &[],
    );

    b.claims(
        &[
            "the certificate expiry chain is fully supported by cross-referenced records",
            "the FATAL is hours earlier, on another host, with no connecting evidence",
            "severity alone must not promote the FATAL to root cause",
        ],
        &["the watchdog FATAL caused the checkout failures"],
        &[],
        &["host-agent internals are outside this corpus"],
    );
    b.expect_pass(0.5, 0.25);
}

// ---------------------------------------------------------------------------
// rb20 — partial / lower-bound corpus
// ---------------------------------------------------------------------------

pub const RB20: RaCaseSpec = RaCaseSpec {
    case_id: "rb20-partial-corpus",
    case_version: 1,
    title: "Partial lower-bound corpus",
    intended_probe: "retention gaps prevent complete analysis; exact totals and complete coverage must not be claimed",
    day: 19,
    scale_cap: Some(8),
    build: build_rb20,
};

fn build_rb20(b: &mut RaCaseBuilder) {
    // runner.log.1 deliberately does NOT exist: segment 2 of 3 rotated away.
    b.source(
        "batch/runner.log.2",
        "batch-runner",
        "batch-01.example",
        RaFormat::Plain,
    );
    b.source(
        "batch/runner.log",
        "batch-runner",
        "batch-01.example",
        RaFormat::Plain,
    );

    let chk = format!("chk-{}", b.rng.hex8_upper());
    let storm = format!("run-{}", b.rng.hex8_upper());

    b.noise("batch/runner.log.2", 0, 1200, 170, &mut |rng, _i| {
        (
            "info",
            format!("batch item processed item=itm-{}", rng.hex8()),
        )
    });
    b.noise("batch/runner.log", 2600, 4200, 210, &mut |rng, _i| {
        (
            "info",
            format!("batch item processed item=itm-{}", rng.hex8()),
        )
    });

    let g_gap = b.group(
        "g01",
        RaRole::Symptom,
        Some("inc1"),
        chk.clone(),
        "wall",
        2600,
        "the current segment references checkpoint data from the rotated-away middle segment",
    );
    b.gevent(
        g_gap,
        "batch/runner.log",
        2600,
        "warn",
        &format!("resuming after gap checkpoint {chk} segment 2 of 3 rotated away totals are lower bounds"),
    );

    let g_storm = b.group(
        "g02",
        RaRole::Symptom,
        Some("inc1"),
        storm.clone(),
        "wall",
        2700,
        "restart storm after the missing checkpoint",
    );
    for offset in [2700i64, 2760, 2820] {
        b.gevent(
            g_storm,
            "batch/runner.log",
            offset,
            "error",
            &format!("job restart missing checkpoint data {storm}"),
        );
    }

    b.partial_corpus(1);

    b.incident(
        "inc1",
        "Jobs restarted after checkpoint data vanished with the rotated-away middle segment; the cause of the original checkpoint loss is in the missing segment.",
        "unknown",
        &[],
        2600,
        2880,
    );

    b.query(
        "q1",
        "broad",
        "What is wrong with the batch runner?",
        plan(&["batch", "restart", "checkpoint"]),
        true,
        &[(g_gap, 1), (g_storm, 1)],
        &[],
    );
    b.query(
        "q2",
        "causal",
        "Why did the jobs lose their checkpoints?",
        plan(&["checkpoint", "missing", "lost"]),
        true,
        &[(g_gap, 1), (g_storm, 1)],
        &[],
    );
    b.query(
        "q3",
        "symptom",
        "Show the job restarts.",
        plan(&["restart", "missing", "checkpoint"]),
        true,
        &[(g_storm, 1)],
        &[],
    );
    b.query(
        "q4",
        "identifier",
        &format!("Find checkpoint {chk}."),
        plan(&[&chk]),
        true,
        &[(g_gap, 1)],
        &[],
    );
    b.query(
        "q5",
        "negative",
        "Is the oldest segment corrupted?",
        plan(&["corrupt", "segment"]),
        false,
        &[],
        &[],
    );
    b.query(
        "q6",
        "competing",
        "Could the restarts have a cause visible in this corpus?",
        plan(&["restart", "checkpoint", "gap"]),
        true,
        &[(g_gap, 1), (g_storm, 1)],
        &[],
    );
    b.query(
        "q7",
        "chronology",
        "How many batch items ran in total today?",
        plan(&["item", "processed"]),
        true,
        &[(g_gap, 1)],
        &[],
    );

    b.claims(
        &[
            "segment 2 of 3 is absent; every total derived from this corpus is a lower bound",
            "the restart storm follows the gap reference",
        ],
        &[
            "an exact total of processed batch items",
            "complete coverage of the batch runner's day",
        ],
        &[],
        &["the middle segment's contents are unknowable from this corpus"],
    );
    b.expect_pass(0.6, 0.3);
}
