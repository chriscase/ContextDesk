#!/usr/bin/env python3
"""Validate shared CLI client-protocol fixtures + thin client presence.

Exercises the **documented** envelope/progress/exit contracts (shipped shapes),
not a reimplementation of product parsers.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
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
    env_err_details = load("envelope.err.details.json")
    check("envelope.err.details not ok", env_err_details.get("ok") is False)
    err_details = (env_err_details.get("error") or {}).get("details") or {}
    check(
        "envelope.err.details carries typed import outcome",
        err_details.get("schemaId") == "contextdesk.import_outcome.v1"
        and err_details.get("class") == "rejected"
        and err_details.get("published") is False,
    )
    check(
        "rejected details never name a corpus",
        "corpusId" not in err_details,
    )
    verdict = load("envelope.completed-verdict.json")
    check("completed verdict keeps ok report", (verdict.get("envelope") or {}).get("ok") is True)
    check("completed verdict process exit", verdict.get("process_exit") in (8, 9, 10))
    check("completed verdict is typed", verdict.get("verdict_kind") in ("not_ready", "non_conforming", "partial"))
    adversarial_ok = load("envelope.adversarial-ok.json")
    adversarial_not_ok = load("envelope.adversarial-not-ok.json")
    adversarial_invalid_ok = load("envelope.adversarial-invalid-ok.json")
    leading_garbage = (FIX / "envelope.adversarial-leading-garbage.txt").read_text(encoding="utf-8")
    multiple_values = (FIX / "envelope.adversarial-multiple-values.txt").read_text(encoding="utf-8")
    check("fixture exists envelope.adversarial-leading-garbage.txt", bool(leading_garbage))
    check("fixture exists envelope.adversarial-multiple-values.txt", bool(multiple_values))
    check("adversarial key order keeps top-level ok", adversarial_ok.get("ok") is True)
    check("nested and misleading text cannot override false", adversarial_not_ok.get("ok") is False)
    check("non-boolean top-level ok is invalid", type(adversarial_invalid_ok.get("ok")) is not bool)

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
            exact_mapping = {
                "python": ('8: "not_ready"', '9: "non_conforming"', '10: "partial"'),
                "node": ('[8, "not_ready"]', '[9, "non_conforming"]', '[10, "partial"]'),
                "java": ('case 8 -> "not_ready"', 'case 9 -> "non_conforming"', 'case 10 -> "partial"'),
                "csharp": ('8 => "not_ready"', '9 => "non_conforming"', '10 => "partial"'),
                "go": ("case 8:", "case 9:", "case 10:"),
                "c": ("exit_code == 8", "exit_code == 9", "exit_code == 10"),
                "cpp": ("exit_code == 8", "exit_code == 9", "exit_code == 10"),
                "rust": ('8 => Some("not_ready")', '9 => Some("non_conforming")', '10 => Some("partial")'),
            }
            check(f"client {lang} exact typed mapping exits 8/9/10", all(part in body for part in exact_mapping[lang]))
            parser_needles = {
                "python": "json.loads(",
                "node": "JSON.parse(",
                "java": "JsonEnvelope.parseOk(",
                "csharp": "JsonDocument.Parse(",
                "go": "json.Unmarshal(",
                "c": "contextdesk_parse_envelope_ok(",
                "cpp": "contextdesk_parse_envelope_ok(",
                "rust": "serde_json::from_str(",
            }
            check(f"client {lang} parses JSON envelope", parser_needles[lang] in body)
            if lang in ("c", "cpp"):
                result_type = "contextdesk_command_result" if lang == "c" else "struct CommandResult"
                check(
                    f"client {lang} returns envelope+exit+typed verdict",
                    result_type in body
                    and "envelope" in body
                    and "exit_code" in body
                    and "verdict" in body,
                )
            if lang == "go":
                check(
                    "client go parses entire stdout, not a final line",
                    'json.Unmarshal([]byte(text)' in body and "strings.Split(text" not in body,
                )

    shared_parser = CLIENTS / "shared" / "contextdesk_envelope.h"
    check("bounded shared C/C++ envelope parser", shared_parser.is_file())
    if shared_parser.is_file():
        parser_text = shared_parser.read_text(encoding="utf-8")
        check("shared parser has byte bound", "CONTEXTDESK_MAX_ENVELOPE_BYTES" in parser_text)
        check("shared parser has depth bound", "CONTEXTDESK_MAX_JSON_DEPTH" in parser_text)

    print("== executable client verdict matrix (available toolchains) ==")
    with tempfile.TemporaryDirectory(prefix="contextdesk-client-protocol-") as td:
        temp = Path(td)
        fake = temp / "contextdesk-fake"
        fake.write_text(
            "#!/usr/bin/env python3\n"
            "import os,sys\n"
            "sys.stdout.write(os.environ['CD_FAKE_BODY'] + '\\n')\n"
            "raise SystemExit(int(os.environ['CD_FAKE_EXIT']))\n",
            encoding="utf-8",
        )
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        runners: dict[str, list[str]] = {"python": [sys.executable, str(CLIENTS / REQUIRED_LANGS["python"])]}
        if shutil.which("node"):
            runners["node"] = ["node", str(CLIENTS / REQUIRED_LANGS["node"])]
        if shutil.which("cc"):
            binary = temp / "client-c"
            harness = temp / "client_c_harness.c"
            harness.write_text(
                '#define CONTEXTDESK_CLIENT_NO_MAIN\n'
                f'#include "{CLIENTS / REQUIRED_LANGS["c"]}"\n'
                'int main(void) { char *args[] = {"capabilities", NULL}; '
                'contextdesk_command_result r = contextdesk_run_json(NULL, args, 1); '
                'int expected = atoi(getenv("CD_FAKE_EXIT")); '
                'if (expected >= 8 && expected <= 10 && (r.exit_code != expected || r.verdict != contextdesk_completed_verdict(expected) || !r.envelope)) return 70; '
                'if (r.envelope) { puts(r.envelope); free(r.envelope); } return r.exit_code; }\n',
                encoding="utf-8",
            )
            built = subprocess.run(["cc", str(harness), "-o", str(binary)], capture_output=True)
            check("client c compiles for matrix", built.returncode == 0, built.stderr.decode(errors="replace")[:300])
            if built.returncode == 0: runners["c"] = [str(binary)]
        if shutil.which("c++"):
            binary = temp / "client-cpp"
            harness = temp / "client_cpp_harness.cpp"
            harness.write_text(
                '#define CONTEXTDESK_CLIENT_NO_MAIN\n'
                f'#include "{CLIENTS / REQUIRED_LANGS["cpp"]}"\n'
                'int main() { CommandResult r = run_json("", {"capabilities"}); '
                'int expected = std::atoi(std::getenv("CD_FAKE_EXIT")); '
                'if (expected >= 8 && expected <= 10 && (r.exit_code != expected || r.verdict != completed_verdict(expected) || r.envelope.empty())) return 70; '
                'if (!r.envelope.empty()) std::cout << r.envelope << "\\n"; return r.exit_code; }\n',
                encoding="utf-8",
            )
            built = subprocess.run(["c++", "-std=c++17", str(harness), "-o", str(binary)], capture_output=True)
            check("client cpp compiles for matrix", built.returncode == 0, built.stderr.decode(errors="replace")[:300])
            if built.returncode == 0: runners["cpp"] = [str(binary)]
        if shutil.which("go"):
            binary = temp / "client-go"
            built = subprocess.run(["go", "build", "-o", str(binary), str(CLIENTS / REQUIRED_LANGS["go"])], capture_output=True)
            check("client go compiles for matrix", built.returncode == 0, built.stderr.decode(errors="replace")[:300])
            if built.returncode == 0: runners["go"] = [str(binary)]
        else:
            print("  SKIP  client go runtime matrix — go toolchain unavailable")
        if shutil.which("cargo"):
            cargo_env = os.environ.copy()
            cargo_env.setdefault("CARGO_TARGET_DIR", str(temp / "cargo-target"))
            manifest = CLIENTS / "rust" / "Cargo.toml"
            built = subprocess.run(["cargo", "build", "--quiet", "--manifest-path", str(manifest)], env=cargo_env, capture_output=True)
            check("client rust compiles for matrix", built.returncode == 0, built.stderr.decode(errors="replace")[:300])
            if built.returncode == 0:
                runners["rust"] = [str(Path(cargo_env["CARGO_TARGET_DIR"]) / "debug" / "contextdesk-cli-client-example")]
        else:
            print("  SKIP  client rust runtime matrix — cargo unavailable")
        java_compiler, java_runtime = shutil.which("javac"), shutil.which("java")
        if java_compiler and java_runtime:
            built = subprocess.run([java_compiler, "-d", str(temp), str(CLIENTS / REQUIRED_LANGS["java"])], capture_output=True)
            unavailable = b"Unable to locate a Java Runtime" in built.stderr
            if unavailable:
                print("  SKIP  client java runtime matrix — Java launcher present but runtime unavailable")
            else:
                check("client java compiles for matrix", built.returncode == 0, built.stderr.decode(errors="replace")[:300])
                if built.returncode == 0: runners["java"] = [java_runtime, "-cp", str(temp), "ContextDeskClient"]
        else:
            print("  SKIP  client java runtime matrix — Java toolchain unavailable")
        csharp_compiler = shutil.which("csc") or shutil.which("mcs")
        if csharp_compiler and shutil.which("dotnet"):
            binary = temp / "ContextDeskClient.exe"
            built = subprocess.run([csharp_compiler, f"-out:{binary}", str(CLIENTS / REQUIRED_LANGS["csharp"])], capture_output=True)
            check("client csharp compiles for matrix", built.returncode == 0, built.stderr.decode(errors="replace")[:300])
            if built.returncode == 0: runners["csharp"] = ["dotnet", str(binary)]
        else:
            print("  SKIP  client csharp runtime matrix — C#/.NET toolchain unavailable")

        body_ok = json.dumps(adversarial_ok, separators=(",", ":"))
        body_not_ok = json.dumps(adversarial_not_ok, separators=(",", ":"))
        body_invalid = json.dumps(adversarial_invalid_ok, separators=(",", ":"))
        for lang, runner in runners.items():
            for exit_code in (8, 9, 10):
                env = {**os.environ, "CONTEXTDESK_BIN": str(fake), "CD_FAKE_BODY": body_ok, "CD_FAKE_EXIT": str(exit_code)}
                ran = subprocess.run([*runner, "capabilities"], env=env, capture_output=True)
                check(f"client {lang} preserves completed verdict exit {exit_code}", ran.returncode == exit_code)
            for label, body, exit_code in (
                ("nested false", body_not_ok, 4),
                ("nonboolean ok", body_invalid, 0),
                ("leading garbage", leading_garbage, 0),
                ("multiple JSON values", multiple_values, 0),
            ):
                env = {**os.environ, "CONTEXTDESK_BIN": str(fake), "CD_FAKE_BODY": body, "CD_FAKE_EXIT": str(exit_code)}
                ran = subprocess.run([*runner, "capabilities"], env=env, capture_output=True)
                check(f"client {lang} rejects {label}", ran.returncode != 0)

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
