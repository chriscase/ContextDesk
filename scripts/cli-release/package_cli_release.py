#!/usr/bin/env python3
"""Offline-testable CLI release packaging for ContextDesk.

Pure layout + checksum + SBOM + draft-manifest helpers. Does not publish
releases. Used by `.github/workflows/cli-release.yml` and mutation tests.

Commands:
  package          — stage one platform archive from CONTEXTDESK_BIN + env
  aggregate        — SHA256SUMS + SBOM + release-manifest over a dir of archives
  assert-draft-only — fail if a manifest claims published=true
  layout-check     — validate a staged archive directory inventory
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tarfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# Platforms the release matrix MUST ship. Mutation tests fail if this set
# diverges from the workflow YAML without an intentional update here + there.
REQUIRED_PLATFORMS: Tuple[str, ...] = (
    "macos-arm64",
    "macos-x64",
    "linux-x64",
    "windows-x64",
)

REQUIRED_ARCHIVE_ENTRIES: Tuple[str, ...] = (
    "contextdesk",  # or contextdesk.exe — checked loosely
    "QUICKSTART.md",
    "CLI.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "build-info.json",
    "demo/",
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def die(msg: str, code: int = 2) -> None:
    print(f"package_cli_release: {msg}", file=sys.stderr)
    raise SystemExit(code)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def require_identity(
    version: str, platform: str, git_sha: str, git_describe: str, channel: str
) -> None:
    if not version or version.strip() in ("", "0", "unknown"):
        die("CLI_VERSION / --version is required and must not be a placeholder")
    if platform not in REQUIRED_PLATFORMS:
        die(
            f"platform {platform!r} not in REQUIRED_PLATFORMS={list(REQUIRED_PLATFORMS)}"
        )
    if not git_sha or git_sha.strip() in ("", "unknown", "0"):
        die("git_sha is required (stale/empty identity is fail-closed)")
    if not git_describe or git_describe.strip() in ("", "unknown", "0"):
        die("git_describe is required")
    if not channel or channel.strip() in ("", "unknown"):
        die("channel is required")


def write_build_info(
    path: Path,
    *,
    version: str,
    platform: str,
    git_sha: str,
    git_describe: str,
    channel: str,
    triple: str,
    binary_name: str,
) -> Dict[str, Any]:
    info = {
        "product": "contextdesk",
        "component": "cli",
        "version": version,
        "platform": platform,
        "target_triple": triple,
        "git_sha": git_sha,
        "git_describe": git_describe,
        "channel": channel,
        "binary": binary_name,
        "built_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "signing": {
            "status": "unsigned",
            "macos_notarization": "not_performed",
            "windows_authenticode": "not_performed",
            "note": "See docs/CLI_PACKAGING.md — RC builds are unsigned by design.",
        },
        "release": {
            "draft_only_in_ci": True,
            "auto_publish": False,
        },
    }
    path.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    return info


def copy_release_docs(stage: Path) -> None:
    mapping = {
        REPO_ROOT / "docs" / "cli-release" / "QUICKSTART.md": stage / "QUICKSTART.md",
        REPO_ROOT / "docs" / "CLI.md": stage / "CLI.md",
        REPO_ROOT / "LICENSE": stage / "LICENSE",
        REPO_ROOT
        / "docs"
        / "cli-release"
        / "THIRD_PARTY_NOTICES.md": stage / "THIRD_PARTY_NOTICES.md",
    }
    for src, dst in mapping.items():
        if not src.is_file():
            die(f"missing packaging source file: {src}")
        shutil.copy2(src, dst)


def copy_synthetic_demo(stage: Path) -> None:
    demo_src = REPO_ROOT / "fixtures" / "cli-release-demo"
    demo_dst = stage / "demo"
    if not demo_src.is_dir():
        die(f"missing synthetic demo fixture: {demo_src}")
    if demo_dst.exists():
        shutil.rmtree(demo_dst)
    shutil.copytree(demo_src, demo_dst)


def stage_package(
    *,
    binary: Path,
    out_dir: Path,
    version: str,
    platform: str,
    git_sha: str,
    git_describe: str,
    channel: str,
    triple: str,
) -> Path:
    require_identity(version, platform, git_sha, git_describe, channel)
    if not binary.is_file():
        die(f"binary not found: {binary}")

    out_dir.mkdir(parents=True, exist_ok=True)
    binary_name = "contextdesk.exe" if platform.startswith("windows") else "contextdesk"
    stage_name = f"contextdesk-{version}-{platform}"
    stage = out_dir / stage_name
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    dest_bin = stage / binary_name
    shutil.copy2(binary, dest_bin)
    if not platform.startswith("windows"):
        dest_bin.chmod(dest_bin.stat().st_mode | 0o111)

    copy_release_docs(stage)
    copy_synthetic_demo(stage)
    build_info = write_build_info(
        stage / "build-info.json",
        version=version,
        platform=platform,
        git_sha=git_sha,
        git_describe=git_describe,
        channel=channel,
        triple=triple,
        binary_name=binary_name,
    )
    # Also emit a top-level copy for CI artifact aggregation
    (out_dir / f"build-info-{platform}.json").write_text(
        json.dumps(build_info, indent=2) + "\n", encoding="utf-8"
    )

    validate_stage_inventory(stage, platform)

    if platform.startswith("windows"):
        archive = out_dir / f"{stage_name}.zip"
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    zf.write(path, arcname=str(path.relative_to(stage)))
    else:
        archive = out_dir / f"{stage_name}.tar.gz"
        with tarfile.open(archive, "w:gz") as tf:
            tf.add(stage, arcname=stage_name)

    print(f"wrote {archive}")
    return archive


def validate_stage_inventory(stage: Path, platform: str) -> List[str]:
    """Fail closed if required release contents are missing."""
    missing: List[str] = []
    bin_name = "contextdesk.exe" if platform.startswith("windows") else "contextdesk"
    if not (stage / bin_name).is_file():
        missing.append(bin_name)
    for name in (
        "QUICKSTART.md",
        "CLI.md",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "build-info.json",
    ):
        if not (stage / name).is_file():
            missing.append(name)
    if not (stage / "demo").is_dir():
        missing.append("demo/")
    else:
        demo_files = list((stage / "demo").rglob("*"))
        if not any(p.is_file() for p in demo_files):
            missing.append("demo/* (empty)")
    if missing:
        die(f"archive stage missing required entries: {missing}")
    # build-info identity must be non-stale
    info = json.loads((stage / "build-info.json").read_text(encoding="utf-8"))
    for key in ("git_sha", "git_describe", "channel", "version", "platform"):
        val = info.get(key)
        if not val or str(val).strip() in ("", "unknown", "0"):
            die(f"build-info.json has empty/stale {key}={val!r}")
    if info.get("release", {}).get("auto_publish") is True:
        die("build-info must not claim auto_publish=true")
    return sorted(str(p.relative_to(stage)) for p in stage.rglob("*") if p.is_file())


def write_sha256sums(directory: Path, files: Sequence[Path]) -> Path:
    lines: List[str] = []
    for path in sorted(files, key=lambda p: p.name):
        digest = sha256_file(path)
        lines.append(f"{digest}  {path.name}\n")
    out = directory / "SHA256SUMS"
    out.write_text("".join(lines), encoding="utf-8")
    if not lines:
        die("SHA256SUMS would be empty — no archives to checksum")
    return out


def write_sbom(
    directory: Path,
    *,
    version: str,
    git_sha: str,
    git_describe: str,
    channel: str,
    archives: Sequence[Path],
) -> Path:
    """Minimal CycloneDX 1.5 JSON SBOM for the CLI release artifacts."""
    components = []
    for arch in archives:
        components.append(
            {
                "type": "file",
                "name": arch.name,
                "version": version,
                "hashes": [{"alg": "SHA-256", "content": sha256_file(arch)}],
            }
        )
    components.append(
        {
            "type": "application",
            "name": "contextdesk",
            "version": version,
            "description": "ContextDesk headless CLI",
            "properties": [
                {"name": "cd:git_sha", "value": git_sha},
                {"name": "cd:git_describe", "value": git_describe},
                {"name": "cd:channel", "value": channel},
            ],
        }
    )
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "component": {
                "type": "application",
                "name": "contextdesk-cli-release",
                "version": version,
            },
            "properties": [
                {"name": "cd:draft_only", "value": "true"},
                {"name": "cd:auto_publish", "value": "false"},
            ],
        },
        "components": components,
    }
    out = directory / "sbom.cdx.json"
    out.write_text(json.dumps(sbom, indent=2) + "\n", encoding="utf-8")
    return out


def write_release_manifest(
    directory: Path,
    *,
    version: str,
    git_sha: str,
    git_describe: str,
    channel: str,
    platforms_found: Sequence[str],
    archives: Sequence[Path],
) -> Path:
    manifest = {
        "schema": "contextdesk.cli.release_manifest.v1",
        "version": version,
        "git_sha": git_sha,
        "git_describe": git_describe,
        "channel": channel,
        "draft": True,
        "published": False,
        "auto_publish": False,
        "required_platforms": list(REQUIRED_PLATFORMS),
        "platforms_found": list(platforms_found),
        "archives": [p.name for p in archives],
        "checksums_file": "SHA256SUMS",
        "sbom_file": "sbom.cdx.json",
        "smoke_required": True,
        "signing": {
            "macos_notarization": "not_performed",
            "windows_authenticode": "not_performed",
        },
    }
    # Fail closed before write if platforms incomplete
    missing = [p for p in REQUIRED_PLATFORMS if p not in platforms_found]
    if missing:
        die(f"release missing required platforms: {missing}")
    out = directory / "release-manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return out


def aggregate(
    directory: Path,
    *,
    version: str,
    git_sha: str,
    git_describe: str,
    channel: str,
) -> None:
    if not version or not git_sha or not git_describe or not channel:
        die("aggregate requires version, git_sha, git_describe, channel")
    archives = sorted(
        list(directory.glob("contextdesk-*.tar.gz"))
        + list(directory.glob("contextdesk-*.zip"))
    )
    if not archives:
        die(f"no archives in {directory}")
    platforms_found: List[str] = []
    for arch in archives:
        # contextdesk-<ver>-<platform>.tar.gz
        name = arch.name
        for p in REQUIRED_PLATFORMS:
            if f"-{p}." in name or name.endswith(f"-{p}.tar.gz") or name.endswith(f"-{p}.zip"):
                platforms_found.append(p)
                break
    platforms_found = sorted(set(platforms_found))
    missing = [p for p in REQUIRED_PLATFORMS if p not in platforms_found]
    if missing:
        die(f"aggregate: missing platforms {missing}; found {platforms_found}")

    sums = write_sha256sums(directory, archives)
    sbom = write_sbom(
        directory,
        version=version,
        git_sha=git_sha,
        git_describe=git_describe,
        channel=channel,
        archives=archives,
    )
    manifest = write_release_manifest(
        directory,
        version=version,
        git_sha=git_sha,
        git_describe=git_describe,
        channel=channel,
        platforms_found=platforms_found,
        archives=archives,
    )
    print(f"wrote {sums}")
    print(f"wrote {sbom}")
    print(f"wrote {manifest}")


def assert_draft_only(manifest_path: Path) -> None:
    if not manifest_path.is_file():
        die(f"manifest not found: {manifest_path}")
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    # Fail closed: a "release pass" that claims published is forbidden.
    if data.get("published") is True:
        die(
            "mutation/guard: release-manifest claims published=true — "
            "CLI CI must only attach to draft releases"
        )
    if data.get("draft") is not True:
        die("mutation/guard: release-manifest.draft must be true")
    if data.get("auto_publish") is True:
        die("mutation/guard: auto_publish must be false")
    print("assert-draft-only: ok")


def cmd_package(_args: argparse.Namespace) -> None:
    binary = Path(os.environ.get("CONTEXTDESK_BIN", "")).expanduser()
    out_dir = Path(os.environ.get("CLI_OUT_DIR", "dist/cli"))
    version = os.environ.get("CLI_VERSION", "")
    platform = os.environ.get("CLI_PLATFORM", "")
    git_sha = os.environ.get("CLI_GIT_SHA", "")
    git_describe = os.environ.get("CLI_GIT_DESCRIBE", "")
    channel = os.environ.get("CLI_CHANNEL", "")
    triple = os.environ.get("CLI_TRIPLE", "unknown")
    stage_package(
        binary=binary,
        out_dir=out_dir,
        version=version,
        platform=platform,
        git_sha=git_sha,
        git_describe=git_describe,
        channel=channel,
        triple=triple,
    )


def cmd_aggregate(args: argparse.Namespace) -> None:
    aggregate(
        Path(args.dir),
        version=args.version,
        git_sha=args.git_sha,
        git_describe=args.git_describe,
        channel=args.channel,
    )


def cmd_assert_draft(args: argparse.Namespace) -> None:
    assert_draft_only(Path(args.manifest))


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_pkg = sub.add_parser("package", help="Stage one platform archive from env")
    p_pkg.set_defaults(func=cmd_package)

    p_agg = sub.add_parser("aggregate", help="SHA256SUMS + SBOM + draft manifest")
    p_agg.add_argument("--dir", required=True)
    p_agg.add_argument("--version", required=True)
    p_agg.add_argument("--git-sha", required=True)
    p_agg.add_argument("--git-describe", required=True)
    p_agg.add_argument("--channel", required=True)
    p_agg.set_defaults(func=cmd_aggregate)

    p_ad = sub.add_parser("assert-draft-only", help="Fail if published=true")
    p_ad.add_argument("--manifest", required=True)
    p_ad.set_defaults(func=cmd_assert_draft)

    args = parser.parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
