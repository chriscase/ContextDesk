#!/usr/bin/env python3
"""Validate shared CLI client-protocol fixtures + thin client presence.

Exercises the **documented** envelope/progress/exit contracts (shipped shapes),
not a reimplementation of product parsers.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIX = ROOT / "fixtures" / "cli-client-protocol"
CLIENTS = ROOT / "packages" / "cli-clients"

REQUIRED_LANGS = {
    "python": "python/contextdesk_client.py",
    "node": "node/contextdesk_client.mjs",
    "java": "java/ContextDeskClient.java",
    "csharp": "csharp/ContextDeskClient.cs",
    "go": "go/contextdesk_client.go",
    "c": "c/contextdesk_client.c",
    "cpp": "cpp/contextdesk_client.cpp",
    "rust": "rust/src/main.rs",
}

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        msg = f"  FAIL  {name}" + (f" — {detail}" if detail else "")
        print(msg)
        failures.append(msg)


def load(name: str) -> dict:
    path = FIX / name
    check(f"fixture exists {name}", path.is_file())
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    print("== fixtures ==")
    caps = load("capabilities.ok.json")
    check("capabilities ok", caps.get("ok") is True)
    data = caps.get("data") or {}
    for k in (
        "cli_version",
        "envelope_schema_version",
        "build_channel",
        "exit_categories",
        "commands",
        "completed_verdict_categories",
        "normalized",
    ):
        check(f"capabilities.data.{k}", k in data)
    check("exit_categories non-empty", bool(data.get("exit_categories")))
    kinds = {c.get("kind") for c in data.get("exit_categories") or []}
    for k in ("success", "user_error", "not_ready", "non_conforming", "partial", "cancelled", "internal"):
        check(f"exit kind {k}", k in kinds)
    verdicts = {
        (item.get("code"), item.get("kind"))
        for item in data.get("completed_verdict_categories") or []
    }
    check("completed verdict exits 8/9/10", verdicts == {(8, "not_ready"), (9, "non_conforming"), (10, "partial")})
    normalized = data.get("normalized") or {}
    for key in (
        "event_schema_id", "event_reader_version", "validation_schema_id",
        "summary_schema_id", "inspection_schema_version", "max_line_bytes",
        "max_files", "max_directories", "max_directory_entries",
        "max_directory_depth", "max_retained_diagnostics",
        "max_retained_error_samples",
    ):
        check(f"capabilities.normalized.{key}", key in normalized)
    for command in ("normalize", "normalized validate", "normalized summarize"):
        check(f"capability command {command}", command in (data.get("commands") or []))

    env_ok = load("envelope.ok.json")
    check("envelope.ok ok", env_ok.get("ok") is True and "data" in env_ok)
    env_err = load("envelope.err.json")
    check("envelope.err not ok", env_err.get("ok") is False)
    check("envelope.err has error.kind", bool((env_err.get("error") or {}).get("kind")))
    verdict = load("envelope.completed-verdict.json")
    check("completed verdict keeps ok report", (verdict.get("envelope") or {}).get("ok") is True)
    check("completed verdict process exit", verdict.get("process_exit") in (8, 9, 10))
    check("completed verdict is typed", verdict.get("verdict_kind") in ("not_ready", "non_conforming", "partial"))

    prog = load("progress.line.json")
    check("progress type", prog.get("type") == "progress")
    check("progress schema_version", prog.get("schema_version") == 1)

    term = load("stream.terminal.done.json")
    check("terminal has type/status", "type" in term or "status" in term)

    exits = load("exit_categories.json")
    check("exit_categories fixture list", isinstance(exits, list) and len(exits) >= 5)

    print("== thin clients present ==")
    for lang, rel in REQUIRED_LANGS.items():
        path = CLIENTS / rel
        check(f"client {lang}", path.is_file(), str(path))
        if path.is_file():
            body = path.read_text(encoding="utf-8")
            # Must spawn / exec the binary — not reimplement import
            spawnish = any(
                s in body
                for s in (
                    "subprocess",
                    "spawn",
                    "exec",
                    "ProcessBuilder",
                    "Command::",
                    "CreateProcess",
                    "os/exec",
                    "Command(",
                    "std::process",
                    "posix_spawn",
                    "execvp",
                    "Runtime.getRuntime",
                    "ProcessStartInfo",
                )
            )
            check(f"client {lang} spawns process", spawnish)
            # Forbid real shell invocation APIs; allow prose like "no system()".
            check(
                f"client {lang} no shell-string join of user input",
                "shell=True" not in body
                and "shell=true" not in body
                and "os.system(" not in body
                and "std::system(" not in body
                and "Runtime.getRuntime().exec(\"" not in body,
            )
            # Must not claim C ABI as primary
            if "ABI" in body or "JNI" in body:
                check(
                    f"client {lang} marks ABI/JNI future",
                    "future" in body.lower() or "Future" in body or "not implemented" in body.lower(),
                )
            for needle in ("not_ready", "non_conforming", "partial"):
                check(f"client {lang} typed verdict {needle}", needle in body)

    print("== protocol doc ==")
    doc = ROOT / "docs" / "CLI_CLIENT_PROTOCOL.md"
    check("protocol doc", doc.is_file())
    if doc.is_file():
        t = doc.read_text(encoding="utf-8")
        for needle in (
            "capabilities",
            "JSONL",
            "cancelled",
            "data-dir",
            "No shell",
            "C ABI",
            "JNI",
            "Future",
            "completed verdict",
            "non_conforming",
            "partial",
        ):
            check(f"doc mentions {needle}", needle.lower() in t.lower() or needle in t)

    if failures:
        print(f"FAILED {len(failures)}")
        return 1
    print("ALL CLIENT PROTOCOL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
