#!/usr/bin/env python3
"""Documentation SHIP gate: links, inventory, command drift, README hub.

Checks:
  1. Required doc files exist
  2. README has prominent "CLI and log normalization" section with required links
  3. Internal markdown links from hub docs resolve on disk
  4. When CONTEXTDESK_BIN is set, --help command list matches docs/CLI.md shipped set
  5. normalize status honesty: if binary lacks normalize, docs must label it planned
  6. One-click proof: README links to docs/NORMALIZATION.md

Exit 0 only if all pass.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
failures: list[str] = []

REQUIRED_DOCS = [
    "README.md",
    "docs/CLI.md",
    "docs/NORMALIZATION.md",
    "docs/LANGUAGE_INTEGRATION.md",
    "docs/CLI_PACKAGING.md",
    "docs/CLI_CLIENT_PROTOCOL.md",
    "docs/specs/NORMALIZED_LOG_EVENTS_V1.md",
    "docs/specs/normalized-log-events/schemas/normalized-log-events.v1.json",
    "fixtures/cli-docs/normalize-examples/manifest.json",
    "fixtures/cli-docs/normalize-examples/normalization-report.json",
    "fixtures/cli-docs/normalize-examples/source-explicit.jsonl",
    "packages/cli-clients/python/contextdesk_client.py",
]

SHIPPED_COMMANDS = {
    "import",
    "corpus",
    "timezone",
    "explore",
    "context",
    "session",
    "chat",
    "config",
    "confluence",
    "capabilities",
    "doctor",
    "help",
}

HUB_LINKS = [
    "docs/CLI.md",
    "docs/NORMALIZATION.md",
    "docs/specs/NORMALIZED_LOG_EVENTS_V1.md",
    "docs/LANGUAGE_INTEGRATION.md",
    "docs/CLI_PACKAGING.md",
]


def fail(msg: str) -> None:
    print(f"  FAIL  {msg}")
    failures.append(msg)


def ok(msg: str) -> None:
    print(f"  PASS  {msg}")


def check_files() -> None:
    print("== inventory ==")
    for rel in REQUIRED_DOCS:
        p = ROOT / rel
        if p.is_file():
            ok(rel)
        else:
            fail(f"missing {rel}")


def check_readme_hub() -> None:
    print("== README hub ==")
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    if re.search(r"(?m)^## CLI and log normalization\s*$", text):
        ok("README has ## CLI and log normalization")
    else:
        fail("README missing ## CLI and log normalization heading")
    # One-click: section must link NORMALIZATION.md before too much noise
    idx = text.find("## CLI and log normalization")
    if idx < 0:
        return
    window = text[idx : idx + 2500]
    if "docs/NORMALIZATION.md" in window or "](docs/NORMALIZATION.md)" in window:
        ok("README section links docs/NORMALIZATION.md (one-click)")
    else:
        fail("README hub does not link docs/NORMALIZATION.md within section")
    for link in HUB_LINKS:
        if link in window or link.replace("docs/", "") in window:
            ok(f"README hub mentions {link}")
        else:
            # allow relative variants
            if f"]({link})" in window or f"](./{link})" in window:
                ok(f"README hub links {link}")
            else:
                fail(f"README hub missing link/mention {link}")
    for label in ("Shipped", "Planned", "Not shipped"):
        if label in window or label.lower() in window.lower():
            ok(f"README status vocabulary includes {label!r}")
            break
    else:
        fail("README hub lacks shipped/planned status labels")


def extract_md_links(path: Path) -> list[tuple[str, str]]:
    text = path.read_text(encoding="utf-8")
    # [text](url) — skip http(s), mailto, anchors-only
    found = []
    for m in re.finditer(r"\[([^\]]+)\]\(([^)]+)\)", text):
        label, url = m.group(1), m.group(2).strip()
        if url.startswith(("http://", "https://", "mailto:")):
            continue
        if url.startswith("#"):
            continue
        # strip anchors
        file_part = url.split("#", 1)[0]
        if not file_part:
            continue
        found.append((label, file_part))
    return found


def check_internal_links() -> None:
    print("== internal markdown links ==")
    roots = [
        ROOT / "README.md",
        ROOT / "docs" / "CLI.md",
        ROOT / "docs" / "NORMALIZATION.md",
        ROOT / "docs" / "LANGUAGE_INTEGRATION.md",
        ROOT / "docs" / "CLI_PACKAGING.md",
        ROOT / "docs" / "CLI_CLIENT_PROTOCOL.md",
    ]
    for doc in roots:
        if not doc.is_file():
            continue
        for label, rel in extract_md_links(doc):
            # resolve relative to doc parent
            target = (doc.parent / rel).resolve()
            try:
                target.relative_to(ROOT.resolve())
            except ValueError:
                # outside repo — skip
                continue
            if target.exists():
                ok(f"{doc.relative_to(ROOT)} → {rel}")
            else:
                fail(f"broken link in {doc.relative_to(ROOT)}: [{label}]({rel})")


def help_commands(bin_path: str) -> set[str]:
    proc = subprocess.run(
        [bin_path, "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode not in (0,):
        # clap may still print help
        pass
    text = proc.stdout + proc.stderr
    cmds: set[str] = set()
    in_cmds = False
    for line in text.splitlines():
        if line.strip().startswith("Commands:"):
            in_cmds = True
            continue
        if in_cmds:
            if line.strip().startswith("Options:"):
                break
            m = re.match(r"\s{2}(\S+)\s+", line)
            if m:
                cmds.add(m.group(1))
    return cmds


def has_normalize(bin_path: str) -> bool:
    proc = subprocess.run(
        [bin_path, "normalize", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    out = (proc.stdout + proc.stderr).lower()
    if "unrecognized subcommand" in out or "unexpected argument" in out:
        return False
    return proc.returncode == 0 or "usage: contextdesk normalize" in out


def check_command_drift() -> None:
    print("== command drift ==")
    bin_path = os.environ.get("CONTEXTDESK_BIN", "").strip()
    cli_md = (ROOT / "docs" / "CLI.md").read_text(encoding="utf-8")
    norm_md = (ROOT / "docs" / "NORMALIZATION.md").read_text(encoding="utf-8")
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    # Docs must always list shipped commands
    for c in sorted(SHIPPED_COMMANDS - {"help"}):
        if c in cli_md:
            ok(f"docs/CLI.md mentions shipped command {c}")
        else:
            fail(f"docs/CLI.md missing shipped command {c}")

    if not bin_path:
        ok("CONTEXTDESK_BIN unset — skip live --help drift (static checks only)")
        # Honesty: normalize must be labeled planned if we can't prove presence
        if re.search(r"Planned|integrating|planned", norm_md, re.I):
            ok("NORMALIZATION.md labels normalize planned/integrating")
        else:
            fail("NORMALIZATION.md must label normalize status when binary not checked")
        return

    if not Path(bin_path).exists():
        fail(f"CONTEXTDESK_BIN not found: {bin_path}")
        return

    cmds = help_commands(bin_path)
    if not cmds:
        fail("could not parse commands from --help")
        return
    ok(f"parsed --help commands: {sorted(cmds)}")

    missing = SHIPPED_COMMANDS - cmds - {"help"}
    # help may appear as subcommand
    for c in sorted(SHIPPED_COMMANDS):
        if c == "help":
            continue
        if c in cmds:
            ok(f"binary has {c}")
        else:
            fail(f"binary missing shipped command {c} (docs claim shipped)")

    if has_normalize(bin_path):
        ok("binary has normalize")
        for needle in ("--output", "source-timezone", "strict-time"):
            # help text
            proc = subprocess.run(
                [bin_path, "normalize", "--help"],
                capture_output=True,
                text=True,
                check=False,
            )
            h = proc.stdout + proc.stderr
            if needle.replace("-", "") in h.replace("-", "") or needle in h:
                ok(f"normalize --help documents {needle}")
            else:
                fail(f"normalize --help missing {needle}")
        if "normalize" not in cli_md:
            fail("binary has normalize but docs/CLI.md never mentions it")
    else:
        ok("binary lacks normalize — docs must not claim it shipped")
        if re.search(r"\*\*Shipped\*\*.*normalize|normalize.*\*\*Shipped\*\*", readme, re.I | re.S):
            # crude: if README table says normalize shipped, fail
            for line in readme.splitlines():
                if "normalize" in line.lower() and "Shipped" in line and "Planned" not in line:
                    if "normalized_log_events" in line or "contract" in line.lower():
                        continue
                    if "Offline `contextdesk normalize`" in line or "contextdesk normalize`" in line:
                        fail(f"README claims normalize shipped while binary lacks it: {line}")
        if "Planned" not in norm_md and "integrating" not in norm_md.lower():
            fail("NORMALIZATION.md must say planned/integrating when binary lacks normalize")
        else:
            ok("NORMALIZATION.md honest about planned/integrating normalize")


def check_fixtures_json() -> None:
    print("== normalize example fixtures ==")
    import json

    for name in (
        "manifest.json",
        "normalization-report.json",
    ):
        p = ROOT / "fixtures" / "cli-docs" / "normalize-examples" / name
        try:
            json.loads(p.read_text(encoding="utf-8"))
            ok(f"valid JSON {name}")
        except Exception as e:
            fail(f"invalid JSON {name}: {e}")
    for name in (
        "source-explicit.jsonl",
        "producer-resolved.jsonl",
        "unresolved.jsonl",
        "order-only.jsonl",
    ):
        p = ROOT / "fixtures" / "cli-docs" / "normalize-examples" / name
        lines = [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        if not lines:
            fail(f"empty {name}")
            continue
        try:
            header = json.loads(lines[0])
            if header.get("schemaId") != "contextdesk.normalized_log_events.v1":
                fail(f"{name} header schemaId wrong")
            else:
                ok(f"{name} header schemaId")
            for ln in lines[1:]:
                json.loads(ln)
            ok(f"{name} events parse")
        except Exception as e:
            fail(f"{name}: {e}")


def main() -> int:
    check_files()
    check_readme_hub()
    check_internal_links()
    check_command_drift()
    check_fixtures_json()
    print()
    if failures:
        print(f"FAILED {len(failures)} check(s)")
        for f in failures:
            print(f" - {f}")
        return 1
    print("ALL CLI DOCS CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
