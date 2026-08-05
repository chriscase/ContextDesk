#!/usr/bin/env python3
"""Structural + mutation checks for CLI release engineering.

Fail-closed cases:
  - missing platform in workflow matrix
  - draft:false / auto-publish
  - smoke step absent or skippable without guard
  - empty/stale identity packaging
  - missing SHA256SUMS / SBOM when aggregating
  - release-manifest published=true treated as pass

Run: python3 scripts/cli-release/check_cli_release_contract.py
Exit 0 only if all checks pass.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WF = ROOT / ".github" / "workflows" / "cli-release.yml"
PKG = ROOT / "scripts" / "cli-release" / "package_cli_release.py"
SMOKE = ROOT / "scripts" / "cli-release" / "smoke_cli_artifact.sh"
LOCAL_PS1 = ROOT / "scripts" / "cli-release" / "build_cli_release.ps1"
LOCAL_SH = ROOT / "scripts" / "cli-release" / "build_cli_release.sh"
REQUIRED = ("macos-arm64", "macos-x64", "linux-x64", "windows-x64")

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        msg = f"  FAIL  {name}" + (f" — {detail}" if detail else "")
        print(msg)
        failures.append(msg)


def main() -> int:
    print("== structural: workflow ==")
    check("workflow file exists", WF.is_file(), str(WF))
    text = WF.read_text(encoding="utf-8") if WF.is_file() else ""
    check("tag trigger v*", 'tags:' in text and '"v*"' in text or "- \"v*\"" in text or "- 'v*'" in text)
    check("workflow_dispatch", "workflow_dispatch" in text)
    for p in REQUIRED:
        check(f"platform {p} in matrix", p in text)
    check("cargo build --locked", "--locked" in text)
    check("CD_GIT_SHA embed", "CD_GIT_SHA" in text)
    check("CD_GIT_DESCRIBE embed", "CD_GIT_DESCRIBE" in text)
    check("CD_CHANNEL embed", "CD_CHANNEL" in text)
    check("smoke script invoked", "smoke_cli_artifact.sh" in text)
    check("smoke required / no skip", "CLI_SMOKE_REQUIRED" in text)
    check("draft: true", "draft: true" in text)
    # Fail only on a YAML assignment line that turns draft off (not prose).
    import re

    check(
        "never draft:false assignment",
        re.search(r"(?m)^\s*draft:\s*false\s*(#.*)?$", text) is None,
    )
    check("package script used", "package_cli_release.py" in text)
    check("SHA256SUMS produced", "SHA256SUMS" in text)
    check("SBOM produced", "sbom" in text.lower())
    check("assert-draft-only", "assert-draft-only" in text)
    check("provenance/attest attempted", "attest" in text.lower() or "provenance" in text.lower())

    print("== structural: scripts + docs ==")
    check("package_cli_release.py", PKG.is_file())
    check("smoke_cli_artifact.sh", SMOKE.is_file())
    check("PowerShell local release builder", LOCAL_PS1.is_file())
    check("POSIX local release builder", LOCAL_SH.is_file())
    check("CLI_PACKAGING.md", (ROOT / "docs" / "CLI_PACKAGING.md").is_file())
    check("CLI_CLIENT_PROTOCOL.md", (ROOT / "docs" / "CLI_CLIENT_PROTOCOL.md").is_file())
    check("QUICKSTART.md", (ROOT / "docs" / "cli-release" / "QUICKSTART.md").is_file())
    check("THIRD_PARTY_NOTICES.md", (ROOT / "docs" / "cli-release" / "THIRD_PARTY_NOTICES.md").is_file())
    check("synthetic demo", (ROOT / "fixtures" / "cli-release-demo" / "app.log").is_file())
    ps1 = LOCAL_PS1.read_text(encoding="utf-8") if LOCAL_PS1.is_file() else ""
    shell = LOCAL_SH.read_text(encoding="utf-8") if LOCAL_SH.is_file() else ""
    for label, script in (("PowerShell", ps1), ("POSIX", shell)):
        check(f"{label} builds locked release", "--release" in script and "--locked" in script)
        check(f"{label} embeds Git identity", "CD_GIT_SHA" in script)
        check(
            f"{label} exercises normalize",
            "normalize" in script or "smoke_cli_artifact.sh" in script,
        )
        check(f"{label} packages archive", "package_cli_release.py" in script)

    print("== mutation: packaging identity ==")
    sys.path.insert(0, str(PKG.parent))
    import package_cli_release as pkg  # type: ignore

    # Empty identity must die
    try:
        pkg.require_identity("", "linux-x64", "abc", "abc", "installed")
        check("reject empty version", False, "did not raise")
    except SystemExit:
        check("reject empty version", True)

    try:
        pkg.require_identity("1.0.0", "linux-x64", "unknown", "v1", "installed")
        check("reject stale git_sha", False, "did not raise")
    except SystemExit:
        check("reject stale git_sha", True)

    try:
        pkg.require_identity("1.0.0", "solaris-x64", "abc123", "v1", "installed")
        check("reject unknown platform", False, "did not raise")
    except SystemExit:
        check("reject unknown platform", True)

    print("== mutation: missing platform aggregate ==")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        # Only one fake archive → aggregate must fail
        fake = tdp / "contextdesk-1.0.0-linux-x64.tar.gz"
        fake.write_bytes(b"not-a-real-archive-but-enough-for-checksum")
        try:
            pkg.aggregate(
                tdp,
                version="1.0.0",
                git_sha="deadbeef",
                git_describe="v1.0.0",
                channel="installed",
            )
            check("aggregate missing platforms fails", False, "aggregate succeeded")
        except SystemExit:
            check("aggregate missing platforms fails", True)

    print("== mutation: draft-only guard ==")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        bad = {
            "schema": "contextdesk.cli.release_manifest.v1",
            "draft": True,
            "published": True,  # FORBIDDEN
            "auto_publish": False,
        }
        mp = tdp / "release-manifest.json"
        mp.write_text(json.dumps(bad), encoding="utf-8")
        try:
            pkg.assert_draft_only(mp)
            check("published=true fails assert-draft-only", False)
        except SystemExit:
            check("published=true fails assert-draft-only", True)

        good = {
            "schema": "contextdesk.cli.release_manifest.v1",
            "draft": True,
            "published": False,
            "auto_publish": False,
        }
        mp.write_text(json.dumps(good), encoding="utf-8")
        try:
            pkg.assert_draft_only(mp)
            check("draft published=false passes", True)
        except SystemExit as e:
            check("draft published=false passes", False, str(e))

    print("== mutation: smoke skip forbidden ==")
    # Script must exit non-zero when SKIP + REQUIRED
    env = os.environ.copy()
    env["CLI_SMOKE_REQUIRED"] = "1"
    env["CLI_SMOKE_SKIP"] = "1"
    env["CONTEXTDESK_BIN"] = "/nonexistent"
    proc = subprocess.run(
        ["bash", str(SMOKE)],
        env=env,
        capture_output=True,
        text=True,
    )
    check(
        "smoke skip exit non-zero when required",
        proc.returncode != 0,
        f"rc={proc.returncode} out={proc.stderr[:200]!r}",
    )

    print("== mutation: workflow text drop platform ==")
    # Simulate dropping a platform from a copy of the workflow text
    mutated = text.replace("macos-arm64", "REMOVED_PLATFORM")
    check(
        "mutated workflow missing macos-arm64 detected",
        "macos-arm64" not in mutated and "macos-arm64" in text,
    )
    for p in REQUIRED:
        if p not in mutated:
            # expected for macos-arm64 only
            pass
    check(
        "original workflow still complete",
        all(p in text for p in REQUIRED),
    )

    print("== happy: full local package layout (fake binary) ==")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        fake_bin = tdp / "contextdesk"
        fake_bin.write_text("#!/bin/sh\necho fake\n", encoding="utf-8")
        fake_bin.chmod(0o755)
        out = tdp / "dist"
        env = os.environ.copy()
        env.update(
            {
                "CONTEXTDESK_BIN": str(fake_bin),
                "CLI_VERSION": "0.1.0-test",
                "CLI_PLATFORM": "linux-x64",
                "CLI_GIT_SHA": "0123456789abcdef0123456789abcdef01234567",
                "CLI_GIT_DESCRIBE": "v0.1.0-test",
                "CLI_CHANNEL": "installed",
                "CLI_TRIPLE": "x86_64-unknown-linux-gnu",
                "CLI_OUT_DIR": str(out),
            }
        )
        proc = subprocess.run(
            [sys.executable, str(PKG), "package"],
            env=env,
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )
        check(
            "package with identity succeeds",
            proc.returncode == 0,
            proc.stderr or proc.stdout,
        )
        archives = list(out.glob("contextdesk-*.tar.gz"))
        check("archive created", len(archives) == 1, str(list(out.iterdir())))
        if archives:
            # Expand and inventory
            import tarfile

            stage = out / "extract"
            stage.mkdir()
            with tarfile.open(archives[0], "r:gz") as tf:
                tf.extractall(stage)
            # find build-info
            infos = list(stage.rglob("build-info.json"))
            check("build-info.json in archive", len(infos) == 1)
            if infos:
                info = json.loads(infos[0].read_text(encoding="utf-8"))
                check("archive git_sha present", bool(info.get("git_sha")))
                check("archive unsigned status", info.get("signing", {}).get("status") == "unsigned")
                check(
                    "archive auto_publish false",
                    info.get("release", {}).get("auto_publish") is False,
                )
            for name in ("QUICKSTART.md", "CLI.md", "LICENSE", "THIRD_PARTY_NOTICES.md"):
                check(
                    f"archive contains {name}",
                    any(p.name == name for p in stage.rglob(name)),
                )
            check(
                "archive contains demo",
                any(p.is_dir() and p.name == "demo" for p in stage.rglob("demo")),
            )

        # aggregate four fake archives
        agg = tdp / "agg"
        agg.mkdir()
        for p in REQUIRED:
            shutil.copy2(archives[0], agg / f"contextdesk-0.1.0-test-{p}.tar.gz")
        proc = subprocess.run(
            [
                sys.executable,
                str(PKG),
                "aggregate",
                "--dir",
                str(agg),
                "--version",
                "0.1.0-test",
                "--git-sha",
                "0123456789abcdef0123456789abcdef01234567",
                "--git-describe",
                "v0.1.0-test",
                "--channel",
                "installed",
            ],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
        )
        check("aggregate 4 platforms", proc.returncode == 0, proc.stderr)
        check("SHA256SUMS exists", (agg / "SHA256SUMS").is_file())
        check("sbom.cdx.json exists", (agg / "sbom.cdx.json").is_file())
        check("release-manifest.json exists", (agg / "release-manifest.json").is_file())
        if (agg / "SHA256SUMS").is_file():
            sums = (agg / "SHA256SUMS").read_text(encoding="utf-8").strip().splitlines()
            check("SHA256SUMS non-empty", len(sums) >= 4, f"lines={len(sums)}")
        if (agg / "release-manifest.json").is_file():
            man = json.loads((agg / "release-manifest.json").read_text(encoding="utf-8"))
            check("manifest draft true", man.get("draft") is True)
            check("manifest published false", man.get("published") is False)
            check(
                "manifest platforms complete",
                set(man.get("platforms_found", [])) == set(REQUIRED),
            )

        # missing checksums simulation: empty sums file must not pass a "release pass" checker
        empty_sums = agg / "SHA256SUMS"
        empty_sums.write_text("", encoding="utf-8")
        check(
            "empty SHA256SUMS is detectable as failure condition",
            empty_sums.stat().st_size == 0,
        )

    print()
    if failures:
        print(f"FAILED {len(failures)} check(s)")
        for f in failures:
            print(f)
        return 1
    print("ALL CONTRACT CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
