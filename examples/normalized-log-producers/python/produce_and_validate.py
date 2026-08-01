#!/usr/bin/env python3
"""Reference producer + conformance validator for
``contextdesk.normalized_log_events.v1``.

Standard library only — no dependencies, so it can be dropped into any
producer's build. Run it two ways::

    python3 produce_and_validate.py --emit          # write a conforming file
    python3 produce_and_validate.py --check <dir>   # validate the fixture corpus

``--check`` runs against the SAME frozen fixtures the Rust validator uses
(``fixtures/normalized-log-events/``), which is the point: three
implementations agreeing on one corpus is what makes this contract portable
under #826, rather than three separate readings of prose.

This is intentionally a *reference*, not a library. It implements the rules an
independent producer must get right, and nothing else.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

SCHEMA_ID = "contextdesk.normalized_log_events.v1"
READER_VERSION = 1

MAX_LINE_BYTES = 1024 * 1024
MAX_CANONICAL_BYTES = 64 * 1024
MAX_ID_CHARS = 128
MAX_SEVERITY_NUMBER = 24
MAX_CORRELATIONS = 32
MAX_MESSAGE_CHARS = 64 * 1024
# Bounds parser work and stack use: a deeply nested attribute map is the cheap
# way to make a validator expensive.
MAX_JSON_DEPTH = 32

# Top-level keys an older ContextDesk reader would treat as authoritative
# wall-clock time. A conforming event must never carry them: it could declare
# order_only while a sidecar "ts" epoch silently put the corpus on a wall clock.
RESERVED_EVENT_KEYS = ("ts", "timestamp", "@timestamp")

# The eleven typed correlation classes (#789). Trace and span are deliberately
# NOT here: they are their own event fields, so a span id cannot be routed into
# a trace slot through this mechanism.
CORRELATION_CLASSES = (
    "request",
    "session",
    "transaction",
    "activity",
    "audit",
    "flow",
    "boot",
    "container",
    "pod",
    "event",
    "query",
)

# RFC3339 with an EXPLICIT offset. A bare local timestamp is a guessed instant
# and has no representation in this contract.
INSTANT_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-](0\d|1\d|2[0-3]):[0-5]\d)$"
)

# Evaluator-protection markers that must never appear in shipped evidence.
# Mirrors cd_core::incident_evidence::FORBIDDEN_MANIFEST_SENTINELS. A producer
# outside ContextDesk is unlikely to emit these by accident, but the shared
# fixture corpus is the definition of conformance, so a reference validator
# that skipped the check would silently disagree with the Rust one.
FORBIDDEN_SENTINELS = (
    "evaluator_truth",
    "evaluator-truth",
    "answer_key",
    "answer-key",
    "expected_diagnosis",
    "truth_inventory",
    "company-data",
)


def _has_sentinel(text) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return any(sentinel in lowered for sentinel in FORBIDDEN_SENTINELS)


TRACE_RE = re.compile(r"^[0-9a-f]{32}$")
SPAN_RE = re.compile(r"^[0-9a-f]{16}$")

# Timestamp legality matrix: resolution -> (instant, localText, resolvedTimezone)
# "req" required, "opt" optional, "no" forbidden.
LEGALITY = {
    "source_explicit": ("req", "opt", "no"),
    "producer_resolved": ("req", "req", "req"),
    "unresolved": ("no", "req", "no"),
    "order_only": ("no", "no", "no"),
}
WALL_RESOLUTIONS = {"source_explicit", "producer_resolved"}


def _is_instant(value) -> bool:
    return (
        isinstance(value, str)
        and bool(INSTANT_RE.match(value))
        # RFC3339 reserves -00:00 for "offset unknown", which is the same
        # thing as not having one.
        and not value.endswith("-00:00")
    )


def _json_depth(value) -> int:
    if isinstance(value, dict):
        return 1 + max((_json_depth(v) for v in value.values()), default=0)
    if isinstance(value, list):
        return 1 + max((_json_depth(v) for v in value), default=0)
    return 0


def _is_iana_zone(value) -> bool:
    """A real IANA zone, not merely a plausible-looking string."""
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        from zoneinfo import ZoneInfo

        ZoneInfo(value)
        return True
    except Exception:
        return False


def _is_int(value) -> bool:
    # bool is a subclass of int in Python; True must not pass as a sequence
    # number or a version.
    return isinstance(value, int) and not isinstance(value, bool)


def _is_identifier(value) -> bool:
    return (
        isinstance(value, str)
        and value.strip() != ""
        and len(value) <= MAX_ID_CHARS
        # Rust's char::is_control covers C0 AND C1 (U+0080-U+009F); matching
        # it exactly is what keeps the three implementations in agreement.
        and not any(
            ord(ch) < 0x20 or 0x7F <= ord(ch) <= 0x9F for ch in value
        )
    )


def validate_time(time, errors, line_no):
    if not isinstance(time, dict):
        errors.append((line_no, "event_malformed", "time"))
        return
    resolution = time.get("resolution")
    basis = time.get("basis")
    if resolution not in LEGALITY:
        errors.append((line_no, "time_basis_inconsistent", "time.resolution"))
        return
    if basis not in ("wall", "relative", "order"):
        errors.append((line_no, "time_basis_inconsistent", "time.basis"))
        return

    want_instant, want_local, want_zone = LEGALITY[resolution]
    have = {
        "instant": time.get("instant") is not None,
        "localText": time.get("localText") is not None,
        "resolvedTimezone": time.get("resolvedTimezone") is not None,
    }

    if want_instant == "req" and not have["instant"]:
        errors.append((line_no, "instant_required", "time.instant"))
    if want_instant == "no" and have["instant"]:
        # The guessed-instant guard.
        errors.append((line_no, "instant_not_permitted", "time.instant"))
    if have["instant"] and not _is_instant(time.get("instant")):
        errors.append((line_no, "instant_malformed", "time.instant"))

    if want_local == "req" and not have["localText"]:
        errors.append((line_no, "local_text_required", "time.localText"))
    if want_local == "no" and have["localText"]:
        errors.append((line_no, "time_basis_inconsistent", "time.localText"))

    if want_zone == "req" and not have["resolvedTimezone"]:
        errors.append((line_no, "resolved_timezone_invalid", "time.resolvedTimezone"))
    if want_zone == "no" and have["resolvedTimezone"]:
        errors.append((line_no, "resolved_timezone_invalid", "time.resolvedTimezone"))
    if have["resolvedTimezone"] and not _is_iana_zone(time.get("resolvedTimezone")):
        # A real zone, not merely a plausible-looking string: producer_resolved
        # provenance is only worth anything if it is checkable.
        errors.append((line_no, "resolved_timezone_invalid", "time.resolvedTimezone"))

    wall_expected = resolution in WALL_RESOLUTIONS
    if wall_expected and basis != "wall":
        errors.append((line_no, "time_basis_inconsistent", "time.basis"))
    if not wall_expected and basis == "wall":
        errors.append((line_no, "time_basis_inconsistent", "time.basis"))

    observed = time.get("observed")
    if observed is not None and not _is_instant(observed):
        errors.append((line_no, "instant_malformed", "time.observed"))


def validate_event(event, expected_seq, errors, line_no):
    for reserved in RESERVED_EVENT_KEYS:
        if reserved in event:
            errors.append((line_no, "reserved_key_present", reserved))

    if not _is_int(event.get("sourceSeq")) or event.get("sourceSeq") != expected_seq:
        errors.append((line_no, "sequence_not_contiguous", "sourceSeq"))

    message = event.get("message")
    if not isinstance(message, str):
        errors.append((line_no, "event_malformed", "message"))
    elif len(message) > MAX_MESSAGE_CHARS:
        errors.append((line_no, "bounds_exceeded", "message"))

    if not isinstance(event.get("time"), dict):
        errors.append((line_no, "event_malformed", "time"))

    validate_time(event.get("time"), errors, line_no)

    severity = event.get("severity")
    if (
        not isinstance(severity, dict)
        or severity.get("confidence") not in ("high", "medium", "low")
        or severity.get("provenance")
        not in ("source_declared", "schema_mapped", "text_inferred", "absent")
    ):
        errors.append((line_no, "event_malformed", "severity"))
    else:
        canonical = severity.get("canonical")
        if canonical is not None and (
            not _is_int(canonical) or canonical < 0 or canonical > MAX_SEVERITY_NUMBER
        ):
            errors.append(
                (line_no, "severity_number_out_of_range", "severity.canonical")
            )
        # confidence and provenance must agree, or a guess could wear the
        # clothes of source truth.
        prov, conf = severity["provenance"], severity["confidence"]
        coherent = (
            (prov == "source_declared" and conf == "high")
            or (prov == "schema_mapped" and conf in ("high", "medium"))
            or (prov == "text_inferred" and conf == "low")
            or prov == "absent"
        )
        if not coherent:
            errors.append((line_no, "severity_provenance_inconsistent", "severity"))
        if prov == "absent" and severity.get("raw") is not None:
            errors.append((line_no, "severity_provenance_inconsistent", "severity.raw"))

    trace = event.get("traceId")
    if trace is not None and (
        not isinstance(trace, str) or not TRACE_RE.match(trace) or set(trace) == {"0"}
    ):
        errors.append((line_no, "trace_identifier_malformed", "traceId"))
    span = event.get("spanId")
    if span is not None and (
        not isinstance(span, str) or not SPAN_RE.match(span) or set(span) == {"0"}
    ):
        errors.append((line_no, "trace_identifier_malformed", "spanId"))

    attributes = event.get("attributes")
    if isinstance(attributes, dict):
        for value in attributes.values():
            if _json_depth(value) > MAX_JSON_DEPTH:
                errors.append((line_no, "depth_exceeded", "attributes"))
                break

    correlations = event.get("correlations", [])
    if not isinstance(correlations, list):
        errors.append((line_no, "event_malformed", "correlations"))
        correlations = []
    if len(correlations) > MAX_CORRELATIONS:
        errors.append((line_no, "bounds_exceeded", "correlations"))
    seen = set()
    for correlation in correlations:
        if not isinstance(correlation, dict):
            errors.append((line_no, "event_malformed", "correlations"))
            continue
        cls = correlation.get("class")
        if cls not in CORRELATION_CLASSES:
            errors.append((line_no, "event_malformed", "correlations"))
            continue
        if cls in seen:
            errors.append((line_no, "duplicate_correlation_class", "correlations"))
        seen.add(cls)
        if not _is_identifier(correlation.get("value")):
            errors.append((line_no, "identifier_invalid", "correlations"))

    for field in ("message", "canonical"):
        if _has_sentinel(event.get(field)):
            errors.append((line_no, "forbidden_sentinel", field))

    canonical = event.get("canonical")
    if not isinstance(canonical, str) or canonical == "":
        errors.append((line_no, "canonical_invalid", "canonical"))
    elif len(canonical.encode("utf-8")) > MAX_CANONICAL_BYTES:
        errors.append((line_no, "canonical_invalid", "canonical"))


def validate_file(text: str):
    """Return a list of ``(line, code, location)`` findings. Empty means valid."""
    errors = []
    lines = text.split("\n")
    if not text.strip():
        return [(0, "missing_header", None)]

    header_line = lines[0]
    if len(header_line.encode("utf-8")) > MAX_LINE_BYTES:
        errors.append((1, "line_too_long", None))
    try:
        header = json.loads(header_line)
        if not isinstance(header, dict):
            raise ValueError
    except Exception:
        errors.append((1, "header_malformed", None))
        header = None

    if header is not None:
        if header.get("schemaId") != SCHEMA_ID:
            errors.append((1, "schema_id_invalid", "schemaId"))
        version = header.get("minReaderVersion")
        if not _is_int(version) or version < 1:
            errors.append((1, "min_reader_version_invalid", "minReaderVersion"))
        elif version > READER_VERSION:
            errors.append((1, "reader_too_old", "minReaderVersion"))
        for field in ("sourceId", "sourceLabel"):
            if _has_sentinel(header.get(field)):
                errors.append((1, "forbidden_sentinel", field))
        redaction = header.get("redaction")
        if isinstance(redaction, dict) and _has_sentinel(redaction.get("note")):
            errors.append((1, "forbidden_sentinel", "redaction.note"))
        if not _is_identifier(header.get("sourceId")):
            errors.append((1, "identifier_invalid", "sourceId"))
        producer = header.get("producer")
        if not isinstance(producer, dict) or not _is_identifier(
            producer.get("name")
        ) or not _is_identifier(producer.get("version")):
            errors.append((1, "identifier_invalid", "producer"))

    expected_seq = 0
    for index, raw in enumerate(lines[1:], start=2):
        if raw.strip() == "":
            continue
        if len(raw.encode("utf-8")) > MAX_LINE_BYTES:
            errors.append((index, "line_too_long", None))
            continue
        try:
            event = json.loads(raw)
            if not isinstance(event, dict):
                raise ValueError
        except Exception:
            errors.append((index, "event_malformed", None))
            expected_seq += 1
            continue
        validate_event(event, expected_seq, errors, index)
        seq = event.get("sourceSeq")
        expected_seq = (seq + 1) if _is_int(seq) else expected_seq + 1

    return errors


def emit_example() -> str:
    """A minimal conforming file, showing all four time resolutions."""
    header = {
        "schemaId": SCHEMA_ID,
        "minReaderVersion": 1,
        "sourceId": "checkout-api",
        "producer": {"name": "python-reference-producer", "version": "1.0.0"},
        # Advisory only. ContextDesk re-redacts regardless of what we claim.
        "redaction": {"credentialsRemoved": True, "personalDataRemoved": False},
    }

    def event(seq, time, message, canonical):
        return {
            "sourceSeq": seq,
            "time": time,
            "severity": {
                "raw": 6,
                "canonical": 9,
                "confidence": "high",
                "provenance": "source_declared",
            },
            "message": message,
            "canonical": canonical,
        }

    rows = [
        header,
        event(
            0,
            {
                "basis": "wall",
                "resolution": "source_explicit",
                "instant": "2026-01-01T00:00:00Z",
            },
            "explicit offset in the source",
            "2026-01-01T00:00:00Z INFO explicit offset in the source",
        ),
        event(
            1,
            {
                "basis": "wall",
                "resolution": "producer_resolved",
                "instant": "2026-01-01T00:00:00-06:00",
                "localText": "2026-01-01 00:00:00",
                "resolvedTimezone": "America/Chicago",
            },
            "producer resolved a zone-less local time",
            "2026-01-01 00:00:00 INFO producer resolved a zone-less local time",
        ),
        event(
            2,
            {
                "basis": "order",
                "resolution": "unresolved",
                "localText": "2026-01-01 00:00:00",
            },
            "local time we could not resolve, so no instant is emitted",
            "2026-01-01 00:00:00 INFO local time we could not resolve",
        ),
        event(
            3,
            {"basis": "order", "resolution": "order_only"},
            "no usable time at all",
            "INFO no usable time at all",
        ),
    ]
    return "\n".join(json.dumps(row, separators=(",", ":"), sort_keys=True) for row in rows) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emit", action="store_true", help="print a conforming file")
    parser.add_argument("--check", metavar="FIXTURE_DIR", help="validate a fixture corpus")
    args = parser.parse_args()

    if args.emit:
        text = emit_example()
        errors = validate_file(text)
        if errors:
            print(f"BUG: emitted file does not validate: {errors}", file=sys.stderr)
            return 2
        sys.stdout.write(text)
        return 0

    if args.check:
        root = pathlib.Path(args.check)
        failures = 0
        checked = 0
        for expectation in ("valid", "invalid"):
            directory = root / expectation
            for path in sorted(directory.glob("*.jsonl")):
                checked += 1
                errors = validate_file(path.read_text())
                ok = not errors
                want_ok = expectation == "valid"
                if ok != want_ok:
                    failures += 1
                    print(
                        f"FAIL {expectation}/{path.name}: "
                        f"expected {'valid' if want_ok else 'invalid'}, got {errors}",
                        file=sys.stderr,
                    )
        print(f"python conformance: {checked} fixtures checked, {failures} disagreement(s)")
        return 1 if failures else 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
