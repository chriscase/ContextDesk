"""Emit the deterministic log parsing/framing conformance corpus.

Every byte here is synthetic and derived from public format documentation
(PostgreSQL log_line_prefix/csvlog/jsonlog, RFC3339, logfmt, and the standard
exception renderings of the JVM, .NET, Python, Rust, and Go runtimes). No
customer, employer, production, or developer-machine material is used.

The corpus deliberately lives outside `fixtures/log-lab/`. The Log Lab safety
scanner treats any dotted token whose last label is alphabetic as a suspected
public hostname, which is correct for an incident corpus but rejects
`java.sql.SQLException`, `django.db.utils.OperationalError`, and
`public.orders` — exactly the content a parser conformance lab must contain.
That scanner is left untouched and still guards fixtures/log-lab; this root
gets the equivalent privacy rules from `conformance_safety` in the Rust suite.

Regenerate with:
    python3 scripts/generate_conformance_corpus.py
"""

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
CORPUS = ROOT / "fixtures/log-conformance/corpus"

# One fixed synthetic instant, far from any DST transition and far from the
# current clock (the safety scan rejects near-now epochs).
BASE_EPOCH = 1_749_988_800  # 2025-06-15T12:00:00Z


def write(rel: str, text: str) -> None:
    path = CORPUS / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_bytes(rel: str, data: bytes) -> None:
    path = CORPUS / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


# ---------------------------------------------------------------------------
# PostgreSQL stderr/text
# ---------------------------------------------------------------------------


def postgres_stderr() -> None:
    # log_line_prefix = '%m [%p] '  (timestamp with ms + zone abbreviation)
    # The ERROR record owns the DETAIL/HINT/STATEMENT lines that follow it:
    # those are continuations of one logical server message, not four events.
    write(
        "postgres-stderr/prefix-m-p.log",
        "\n".join(
            [
                "2025-06-15 12:00:00.123 UTC [1042] LOG:  database system is ready to accept connections",
                "2025-06-15 12:00:01.500 UTC [1103] ERROR:  duplicate key value violates unique constraint \"orders_pkey\"",
                "2025-06-15 12:00:01.500 UTC [1103] DETAIL:  Key (id)=(42) already exists.",
                "2025-06-15 12:00:01.500 UTC [1103] HINT:  Retry with a fresh identifier.",
                "2025-06-15 12:00:01.500 UTC [1103] STATEMENT:  INSERT INTO orders (id, label) VALUES (42, 'demo');",
                "2025-06-15 12:00:02.001 UTC [1042] LOG:  checkpoint starting: time",
            ]
        )
        + "\n",
    )

    # log_line_prefix = '%t [%p]: [%l-1] user=%u,db=%d,app=%a,client=%h '
    # %t carries no milliseconds; the client host is an RFC 5737 documentation
    # address.
    write(
        "postgres-stderr/prefix-verbose.log",
        "\n".join(
            [
                "2025-06-15 12:05:10 UTC [2001]: [1-1] user=app_user,db=appdb,app=worker,client=192.0.2.15 LOG:  statement: SELECT 1",
                "2025-06-15 12:05:11 UTC [2001]: [2-1] user=app_user,db=appdb,app=worker,client=192.0.2.15 ERROR:  canceling statement due to statement timeout",
                "2025-06-15 12:05:11 UTC [2001]: [3-1] user=app_user,db=appdb,app=worker,client=192.0.2.15 CONTEXT:  while updating tuple in relation \"orders\"",
                "2025-06-15 12:05:12 UTC [2002]: [1-1] user=[unknown],db=[unknown],app=[unknown],client=192.0.2.31 LOG:  connection received",
            ]
        )
        + "\n",
    )

    # A zone ABBREVIATION that is genuinely ambiguous (CST is North America or
    # China depending on deployment). The parser must never guess an instant.
    write(
        "postgres-stderr/prefix-ambiguous-zone.log",
        "\n".join(
            [
                "2025-06-15 08:05:10.004 CST [3001] WARNING:  there is already a transaction in progress",
                "2025-06-15 08:05:11.007 CST [3001] LOG:  duration: 1523.004 ms  statement: SELECT count(*) FROM orders",
            ]
        )
        + "\n",
    )

    # Rotation: two files whose time ranges overlap. Source identity must stay
    # distinct even though the records interleave in time.
    write(
        "postgres-stderr/rotated/postgresql-12.log",
        "\n".join(
            [
                "2025-06-15 12:59:58.000 UTC [4001] LOG:  checkpoint complete",
                "2025-06-15 13:00:00.500 UTC [4001] LOG:  received SIGHUP, reloading configuration files",
            ]
        )
        + "\n",
    )
    write(
        "postgres-stderr/rotated/postgresql-13.log",
        "\n".join(
            [
                "2025-06-15 12:59:59.750 UTC [4002] LOG:  automatic vacuum of table \"appdb.public.orders\"",
                "2025-06-15 13:00:01.250 UTC [4002] LOG:  parameter \"log_min_duration_statement\" changed to \"250ms\"",
            ]
        )
        + "\n",
    )


# ---------------------------------------------------------------------------
# PostgreSQL csvlog / jsonlog
# ---------------------------------------------------------------------------

CSV_COLUMNS = [
    "log_time", "user_name", "database_name", "process_id", "connection_from",
    "session_id", "session_line_num", "command_tag", "session_start_time",
    "virtual_transaction_id", "transaction_id", "error_severity",
    "sql_state_code", "message", "detail", "hint", "internal_query",
    "internal_query_pos", "context", "query", "query_pos", "location",
    "application_name", "backend_type", "leader_pid", "query_id",
]


def csv_row(values: dict) -> str:
    out = []
    for column in CSV_COLUMNS:
        raw = values.get(column, "")
        if raw == "":
            out.append("")
            continue
        text = str(raw)
        # PostgreSQL always quotes text fields and doubles embedded quotes.
        out.append('"' + text.replace('"', '""') + '"')
    return ",".join(out)


def postgres_csvlog() -> None:
    rows = [
        csv_row({
            "log_time": "2025-06-15 12:10:00.100 UTC", "user_name": "app_user",
            "database_name": "appdb", "process_id": 5001,
            "connection_from": "192.0.2.15:54321", "session_id": "684e7b10.1389",
            "session_line_num": 1, "command_tag": "idle",
            "session_start_time": "2025-06-15 12:09:00 UTC",
            "virtual_transaction_id": "3/17", "error_severity": "LOG",
            "sql_state_code": "00000",
            "message": "connection authorized: user=app_user database=appdb",
            "application_name": "worker", "backend_type": "client backend",
        }),
        # A quoted field containing an embedded newline: one logical CSV record
        # spanning three physical lines. This is the framing case.
        csv_row({
            "log_time": "2025-06-15 12:10:05.250 UTC", "user_name": "app_user",
            "database_name": "appdb", "process_id": 5001,
            "connection_from": "192.0.2.15:54321", "session_id": "684e7b10.1389",
            "session_line_num": 2, "command_tag": "INSERT",
            "session_start_time": "2025-06-15 12:09:00 UTC",
            "virtual_transaction_id": "3/18", "error_severity": "ERROR",
            "sql_state_code": "23505",
            "message": "duplicate key value violates unique constraint \"orders_pkey\"",
            "detail": "Key (id)=(42) already exists.",
            "query": "INSERT INTO orders (id, label)\nVALUES (42, 'demo')\nRETURNING id",
            "query_pos": 1, "application_name": "worker",
            "backend_type": "client backend",
        }),
        csv_row({
            "log_time": "2025-06-15 12:10:09.900 UTC", "user_name": "app_user",
            "database_name": "appdb", "process_id": 5001,
            "connection_from": "192.0.2.15:54321", "session_id": "684e7b10.1389",
            "session_line_num": 3, "command_tag": "SELECT",
            "session_start_time": "2025-06-15 12:09:00 UTC",
            "virtual_transaction_id": "3/19", "error_severity": "WARNING",
            "sql_state_code": "01000",
            "message": "there is no transaction in progress",
            "application_name": "worker", "backend_type": "client backend",
        }),
    ]
    write("postgres-csvlog/postgresql-csv.log", "\n".join(rows) + "\n")


def postgres_jsonlog() -> None:
    records = [
        {
            "timestamp": "2025-06-15 12:20:00.100 UTC", "user": "app_user",
            "dbname": "appdb", "pid": 6001, "remote_host": "192.0.2.15",
            "remote_port": 54322, "session_id": "684e7d20.1771", "line_num": 1,
            "ps": "idle", "session_start": "2025-06-15 12:19:00 UTC",
            "vxid": "4/21", "error_severity": "LOG", "state_code": "00000",
            "message": "connection authorized: user=app_user database=appdb",
            "application_name": "worker", "backend_type": "client backend",
        },
        {
            "timestamp": "2025-06-15 12:20:05.250 UTC", "user": "app_user",
            "dbname": "appdb", "pid": 6001, "remote_host": "192.0.2.15",
            "remote_port": 54322, "session_id": "684e7d20.1771", "line_num": 2,
            "ps": "INSERT", "session_start": "2025-06-15 12:19:00 UTC",
            "vxid": "4/22", "txid": 9931, "error_severity": "ERROR",
            "state_code": "23505",
            "message": "duplicate key value violates unique constraint \"orders_pkey\"",
            "detail": "Key (id)=(42) already exists.",
            "statement": "INSERT INTO orders (id, label) VALUES (42, 'demo');",
            "cursor_position": 1, "func_name": "_bt_check_unique",
            "application_name": "worker", "backend_type": "client backend",
        },
        {
            "timestamp": "2025-06-15 12:20:11.000 UTC", "user": "app_user",
            "dbname": "appdb", "pid": 6001, "remote_host": "192.0.2.15",
            "remote_port": 54322, "session_id": "684e7d20.1771", "line_num": 3,
            "ps": "SELECT", "session_start": "2025-06-15 12:19:00 UTC",
            "vxid": "4/23", "error_severity": "FATAL", "state_code": "57P01",
            "message": "terminating connection due to administrator command",
            "application_name": "worker", "backend_type": "client backend",
        },
    ]
    write(
        "postgres-jsonlog/postgresql-json.log",
        "\n".join(json.dumps(r, separators=(",", ":")) for r in records) + "\n",
    )


# ---------------------------------------------------------------------------
# Structured JSON / logfmt
# ---------------------------------------------------------------------------


def structured() -> None:
    # Timestamp alias x encoding matrix. `id` names the conformance case.
    records = [
        {"id": "ts-rfc3339-z", "ts": "2025-06-15T12:00:00Z", "level": "info", "message": "rfc3339 utc"},
        {"id": "ts-rfc3339-offset", "ts": "2025-06-15T17:30:00+05:30", "level": "info", "message": "rfc3339 offset"},
        {"id": "timestamp-epoch-seconds", "timestamp": BASE_EPOCH, "level": "warn", "message": "epoch seconds"},
        {"id": "time-epoch-millis", "time": BASE_EPOCH * 1000, "level": "error", "message": "epoch milliseconds"},
        {"id": "at-timestamp-epoch-micros", "@timestamp": BASE_EPOCH * 1_000_000, "level": "debug", "message": "epoch microseconds"},
        {"id": "ts-epoch-nanos", "ts": BASE_EPOCH * 1_000_000_000, "level": "info", "message": "epoch nanoseconds"},
        # Complete local calendar time with no zone: evidence, never an instant.
        {"id": "ts-offsetless-local", "ts": "2025-06-15T12:00:00", "level": "info", "message": "offsetless local"},
        {"id": "ts-offsetless-local-space", "ts": "2025-06-15 12:00:00.250", "level": "info", "message": "offsetless local with space"},
        # Linux `date`-style calendar string: no offset, month name, must not guess.
        {"id": "ts-linux-calendar", "ts": "Sun Jun 15 12:00:00 2025", "level": "info", "message": "linux calendar string"},
        # A bare 8-digit number is a date-like integer, not an epoch.
        {"id": "ts-ambiguous-yyyymmdd", "ts": 20250615, "level": "info", "message": "ambiguous yyyymmdd"},
        # Serilog / Bunyan style aliases the current alias list does not know.
        {"id": "ts-alias-serilog", "@t": "2025-06-15T12:00:00Z", "level": "info", "message": "serilog alias"},
        {"id": "ts-alias-event-time", "eventTime": "2025-06-15T12:00:00Z", "level": "info", "message": "eventTime alias"},
    ]
    write(
        "structured/json-ts-matrix.log",
        "\n".join(json.dumps(r, separators=(",", ":")) for r in records) + "\n",
    )

    # Correlation identity: a record carrying only span_id must not have that
    # value promoted into trace_id.
    records = [
        {"id": "span-only", "ts": "2025-06-15T12:30:00Z", "level": "info",
         "span_id": "00f067aa0ba902b7", "message": "span without trace"},
        {"id": "trace-and-span", "ts": "2025-06-15T12:30:01Z", "level": "info",
         "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
         "span_id": "00f067aa0ba902b7", "message": "both present"},
        {"id": "request-id-only", "ts": "2025-06-15T12:30:02Z", "level": "info",
         "request_id": "req-7f3a", "message": "request id only"},
    ]
    write(
        "structured/trace-vs-span.log",
        "\n".join(json.dumps(r, separators=(",", ":")) for r in records) + "\n",
    )

    # Extended severity vocabularies whose source meaning must survive.
    records = [
        {"id": "sev-trace", "ts": "2025-06-15T12:40:00Z", "level": "TRACE", "message": "trace level"},
        {"id": "sev-notice", "ts": "2025-06-15T12:40:01Z", "level": "NOTICE", "message": "notice level"},
        {"id": "sev-critical", "ts": "2025-06-15T12:40:02Z", "level": "CRITICAL", "message": "critical level"},
        {"id": "sev-emergency", "ts": "2025-06-15T12:40:03Z", "level": "EMERGENCY", "message": "emergency level"},
        {"id": "sev-numeric-pino", "ts": "2025-06-15T12:40:04Z", "level": 50, "message": "pino numeric level"},
        {"id": "sev-negation", "ts": "2025-06-15T12:40:05Z", "message": "no errors detected during startup"},
    ]
    write(
        "structured/severity-vocabulary.log",
        "\n".join(json.dumps(r, separators=(",", ":")) for r in records) + "\n",
    )

    write(
        "structured/logfmt-records.log",
        "\n".join(
            [
                'ts=2025-06-15T12:50:00Z level=info msg="server listening" service=gateway port=8443',
                'time=2025-06-15T12:50:01Z level=error msg="upstream refused" service=gateway trace_id=4bf92f35',
                'timestamp=1749988802 level=warn msg="retry scheduled" service=gateway attempt=2',
                'ts="2025-06-15 12:50:03" level=info msg="offsetless local in logfmt" service=gateway',
            ]
        )
        + "\n",
    )


# ---------------------------------------------------------------------------
# Multiline exception renderings
# ---------------------------------------------------------------------------


def multiline() -> None:
    write(
        "multiline/java-exception.log",
        "\n".join(
            [
                "2025-06-15 13:00:00,100 ERROR [com.example.svc.OrderService] (worker-1) Order submission failed",
                "java.sql.SQLException: connection refused",
                "\tat com.example.svc.OrderService.handle(OrderService.java:42)",
                "\tat com.example.svc.OrderController.post(OrderController.java:19)",
                "Caused by: java.net.ConnectException: Connection refused",
                "\tat java.base/sun.nio.ch.Net.pollConnect(Native Method)",
                "\t... 14 more",
                "\tSuppressed: java.lang.IllegalStateException: pool already closed",
                "\t\tat com.example.svc.Pool.close(Pool.java:88)",
                "2025-06-15 13:00:01,200 INFO  [com.example.svc.OrderService] (worker-1) Retry scheduled",
            ]
        )
        + "\n",
    )

    write(
        "multiline/kotlin-exception.log",
        "\n".join(
            [
                "2025-06-15 13:05:00,000 ERROR [com.example.svc.OrderKt] (dispatcher-2) coroutine failed",
                "kotlinx.coroutines.JobCancellationException: Parent job is Cancelling",
                "\tat com.example.svc.OrderKt$handle$1.invokeSuspend(Order.kt:18)",
                "\tat kotlin.coroutines.jvm.internal.BaseContinuationImpl.resumeWith(ContinuationImpl.kt:33)",
                "Caused by: java.util.concurrent.TimeoutException: timed out after 30s",
                "\t... 7 more",
            ]
        )
        + "\n",
    )

    write(
        "multiline/dotnet-exception.log",
        "\n".join(
            [
                "2025-06-15 13:10:00.000 +00:00 [ERR] Order submission failed",
                "System.Data.SqlClient.SqlException (0x80131904): Timeout expired.",
                "   at Example.Svc.OrderService.Handle() in /src/svc/OrderService.cs:line 42",
                "   at Example.Svc.OrderController.Post() in /src/svc/OrderController.cs:line 19",
                " ---> System.TimeoutException: The operation timed out.",
                "   --- End of inner exception stack trace ---",
                "2025-06-15 13:10:01.000 +00:00 [INF] Retry scheduled",
            ]
        )
        + "\n",
    )

    write(
        "multiline/python-traceback.log",
        "\n".join(
            [
                "2025-06-15 13:15:00,000 ERROR order.worker Order submission failed",
                "Traceback (most recent call last):",
                '  File "/srv/app/worker.py", line 42, in handle',
                "    submit(order)",
                '  File "/srv/app/client.py", line 19, in submit',
                "    raise ConnectionError(\"connection refused\")",
                "ConnectionError: connection refused",
                "",
                "During handling of the above exception, another exception occurred:",
                "",
                "Traceback (most recent call last):",
                '  File "/srv/app/worker.py", line 45, in handle',
                "    rollback()",
                "RuntimeError: rollback failed",
                "2025-06-15 13:15:01,000 INFO order.worker Retry scheduled",
            ]
        )
        + "\n",
    )

    write(
        "multiline/rust-panic.log",
        "\n".join(
            [
                "2025-06-15T13:20:00Z ERROR order_worker: task panicked",
                "thread 'worker-1' panicked at src/order.rs:42:9:",
                "called `Option::unwrap()` on a `None` value",
                "stack backtrace:",
                "   0: rust_begin_unwind",
                "   1: core::panicking::panic_fmt",
                "   2: order_worker::order::handle",
                "note: Some details are omitted, run with `RUST_BACKTRACE=full`.",
                "2025-06-15T13:20:01Z INFO order_worker: supervisor restarting task",
            ]
        )
        + "\n",
    )

    write(
        "multiline/go-panic.log",
        "\n".join(
            [
                "2025/06/15 13:25:00 order worker starting",
                "panic: runtime error: invalid memory address or nil pointer dereference",
                "[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x45f2a1]",
                "",
                "goroutine 17 [running]:",
                "example.test/svc.(*Order).Handle(0x0)",
                "\t/src/svc/order.go:42 +0x21",
                "example.test/svc.main()",
                "\t/src/svc/main.go:19 +0x64",
                "exit status 2",
            ]
        )
        + "\n",
    )

    # Adversary: indentation and the literal text "Caused by:" appear inside
    # records that are genuinely new events. A framer that keys on leading
    # whitespace or that substring alone will merge these incorrectly.
    write(
        "multiline/false-continuation.log",
        "\n".join(
            [
                "2025-06-15 13:30:00,000 INFO  [com.example.svc.Audit] (main) audit begin",
                "2025-06-15 13:30:01,000 INFO  [com.example.svc.Audit] (main) user note: Caused by: operator request",
                "        2025-06-15 13:30:02,000 WARN  [com.example.svc.Audit] (main) indented but timestamped record",
                "2025-06-15 13:30:03,000 INFO  [com.example.svc.Audit] (main) audit end",
            ]
        )
        + "\n",
    )


# ---------------------------------------------------------------------------
# Mixed and hostile input
# ---------------------------------------------------------------------------


def mixed_hostile() -> None:
    write(
        "mixed-hostile/mixed-structured-plain.log",
        "\n".join(
            [
                "=== gateway build 2025.06.15 ===",
                '{"ts":"2025-06-15T14:00:00Z","level":"info","message":"json record in a mixed file"}',
                "ts=2025-06-15T14:00:01Z level=warn msg=\"logfmt record in a mixed file\" service=gateway",
                "<190>1 2025-06-15T14:00:02Z gateway.example app 1234 ID47 - rfc5424 record",
                "plain trailing banner line with no structure at all",
            ]
        )
        + "\n",
    )

    write(
        "mixed-hostile/malformed.log",
        "\n".join(
            [
                '{"ts":"2025-06-15T14:10:00Z","level":"info","message":"well formed"}',
                '{"ts":"2025-06-15T14:10:01Z","level":"info","message":"truncated"',
                '{"ts":"2025-06-15T14:10:02Z","ts":"2025-06-15T23:59:59Z","level":"info","message":"duplicate keys"}',
                '{"ts":{"nested":"object"},"level":"info","message":"timestamp is not scalar"}',
                '{"ts":"2025-06-15T14:10:04Z","level":["array"],"message":"level is not scalar"}',
                "{}",
                "[]",
            ]
        )
        + "\n",
    )

    # Invalid UTF-8: a lone continuation byte and a truncated 3-byte sequence.
    # The record must survive as evidence with normalization recorded, never
    # be dropped and never crash the decoder.
    write_bytes(
        "mixed-hostile/invalid-utf8.log",
        b"2025-06-15 14:20:00 UTC valid ascii record\n"
        + b"2025-06-15 14:20:01 UTC lone continuation \x80 byte\n"
        + b"2025-06-15 14:20:02 UTC truncated sequence \xe2\x82 end\n"
        + b"2025-06-15 14:20:03 UTC valid ascii again\n",
    )

    long_body = "x" * 40_000
    write(
        "mixed-hostile/long-record.log",
        "\n".join(
            [
                "2025-06-15 14:30:00 UTC short record before",
                f"2025-06-15 14:30:01 UTC long payload {long_body}",
                "2025-06-15 14:30:02 UTC short record after",
            ]
        )
        + "\n",
    )

    # Escaped \n inside a JSON string is one logical record; a pretty-printed
    # object is one logical record spanning five physical lines.
    write(
        "mixed-hostile/embedded-newline.log",
        '{"ts":"2025-06-15T14:40:00Z","level":"error","message":"line one\\nline two\\nline three"}\n'
        + "{\n"
        + '  "ts": "2025-06-15T14:40:01Z",\n'
        + '  "level": "info",\n'
        + '  "message": "pretty printed object"\n'
        + "}\n"
        + '{"ts":"2025-06-15T14:40:02Z","level":"info","message":"back to one line"}\n',
    )

    for region, port in (("region-a", 8443), ("region-b", 8444)):
        write(
            f"mixed-hostile/dup-basename/{region}/app.log",
            "\n".join(
                [
                    f'{{"ts":"2025-06-15T14:50:00Z","level":"info","message":"listening","port":{port}}}',
                    f'{{"ts":"2025-06-15T14:50:01Z","level":"warn","message":"shared basename","region":"{region}"}}',
                ]
            )
            + "\n",
        )

    # Rotation overlap: the same logical stream split across two files whose
    # time ranges overlap, with one duplicated record.
    write(
        "mixed-hostile/rotation-overlap/app.log",
        "\n".join(
            [
                '{"ts":"2025-06-15T15:00:02Z","level":"info","message":"overlapping record"}',
                '{"ts":"2025-06-15T15:00:03Z","level":"info","message":"only in current"}',
            ]
        )
        + "\n",
    )
    write(
        "mixed-hostile/rotation-overlap/app.log.1",
        "\n".join(
            [
                '{"ts":"2025-06-15T15:00:01Z","level":"info","message":"only in rotated"}',
                '{"ts":"2025-06-15T15:00:02Z","level":"info","message":"overlapping record"}',
            ]
        )
        + "\n",
    )


# ---------------------------------------------------------------------------
# Layered transport envelopes carrying their own payload grammar
# ---------------------------------------------------------------------------


def layered() -> None:
    # Docker `json-file` envelope. The outer object owns time and stream; the
    # `log` field carries a complete inner record with its own timestamp and
    # severity. Inner parsing must not erase the outer transport metadata.
    inner_pino = json.dumps(
        {"level": 50, "time": (BASE_EPOCH + 14400) * 1000, "msg": "inner pino record"},
        separators=(",", ":"),
    )
    inner_spring = "2025-06-15 16:00:01.500 ERROR 1 --- [main] c.e.s.Order : inner spring record"
    write(
        "layered/docker-json-file.log",
        "\n".join(
            [
                json.dumps(
                    {"log": inner_pino + "\n", "stream": "stdout",
                     "time": "2025-06-15T16:00:00.000000000Z"},
                    separators=(",", ":"),
                ),
                json.dumps(
                    {"log": inner_spring + "\n", "stream": "stderr",
                     "time": "2025-06-15T16:00:01.000000000Z"},
                    separators=(",", ":"),
                ),
            ]
        )
        + "\n",
    )

    # CRI: `<time> <stream> <P|F> <payload>`. A `P` line is a partial fragment
    # that must be joined to the following `F` line before the payload is read.
    write(
        "layered/cri.log",
        "\n".join(
            [
                '2025-06-15T16:10:00.000000000Z stdout F {"level":"error","msg":"cri full record"}',
                '2025-06-15T16:10:01.000000000Z stdout P {"level":"warn","msg":"cri split',
                '2025-06-15T16:10:01.000000000Z stdout F  record"}',
                "2025-06-15T16:10:02.000000000Z stderr F plain cri payload",
            ]
        )
        + "\n",
    )

    # RFC5424 carrying a CEF payload, and RFC3164 carrying logfmt.
    write(
        "layered/syslog-payload.log",
        "\n".join(
            [
                "<134>1 2025-06-15T16:20:00.000Z gw.example app 1234 ID1 - "
                "CEF:0|Example|Gateway|1.0|100|connection blocked|5|src=192.0.2.9 dst=192.0.2.10 spt=443",
                "<38>Jun 15 16:20:01 gw.example app[1234]: "
                'level=warn msg="rfc3164 wrapping logfmt" service=gateway',
            ]
        )
        + "\n",
    )


def main() -> None:
    import datetime

    checked = datetime.datetime.fromtimestamp(BASE_EPOCH, datetime.timezone.utc)
    assert checked.isoformat() == "2025-06-15T12:00:00+00:00", checked

    postgres_stderr()
    postgres_csvlog()
    postgres_jsonlog()
    structured()
    multiline()
    layered()
    mixed_hostile()

    files = sorted(p for p in CORPUS.rglob("*") if p.is_file())
    total = sum(p.stat().st_size for p in files)
    print(f"wrote {len(files)} corpus files, {total} bytes")
    for path in files:
        print(f"  {path.relative_to(CORPUS)}  {path.stat().st_size}")


if __name__ == "__main__":
    main()
