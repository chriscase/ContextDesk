#!/usr/bin/env python3
"""Fail-closed ContextDesk release contract (desktop + CLI).

This module is the single orchestration brain used by
`.github/workflows/release.yml` (assemble a draft) and
`.github/workflows/release-promote.yml` (publish only after validation).

It never prints secret values. GitHub mutation happens only when a token is
supplied by the caller; unit tests use an in-memory store.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tomllib
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlparse

SCHEMA = "contextdesk.release_manifest.v1"
CHANNEL_INSTALLED = "installed"
FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TAG_RE = re.compile(
    r"^v(?P<core>\d+\.\d+\.\d+)(?P<pre>-[0-9A-Za-z.-]+)?$"
)
VERSION_TOKEN_RE = re.compile(
    r"\d+\.\d+\.\d+(?:-(?:rc|alpha|beta|pre)[0-9A-Za-z.]*)?",
    re.IGNORECASE,
)
TEST_SIG_PREFIX = "cd-test-sig:"
MINISIGN_HINTS = ("untrusted comment", "RW", "dW50cnVzdGVk")

REQUIRED_DESKTOP = ("macos", "windows", "linux")
REQUIRED_CLI = ("macos-arm64", "macos-x64", "linux-x64", "windows-x64")
# Historical tainted cut: never reattach or retarget these assets onto another
# tag/SHA. Building a *new* v0.1.0-rc5 from the current SHA is not reuse.
FORBIDDEN_REUSE_TAGS = ("v0.1.0-rc5",)

METADATA_NAMES = frozenset(
    {
        "SHA256SUMS",
        "inventory.txt",
        "sbom.cdx.json",
        "release-manifest.json",
        "latest.json",
    }
)

# Honest signing posture. Apple/Authenticode remain unset until a future
# workflow actually wires named secrets and jobs. Do not invent secret names.
SIGNING_POSTURE = {
    "updater": {
        "secret_names": [
            "TAURI_SIGNING_PRIVATE_KEY",
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        ],
        "required_for_ga": True,
        "configured_in_workflow": True,
    },
    "macos_notarization": {
        "secret_names": [],
        "required_for_ga": False,
        "configured_in_workflow": False,
        "honest_status": "not_configured",
    },
    "windows_authenticode": {
        "secret_names": [],
        "required_for_ga": False,
        "configured_in_workflow": False,
        "honest_status": "not_configured",
    },
}

WAR_ROOM_STATUS = "source_run_separate"

DEFAULT_DOWNLOAD_REPO = "chriscase/ContextDesk"


class ContractError(Exception):
    """Fail-closed contract violation."""


def die(msg: str, code: int = 2) -> None:
    print(f"release_contract: {msg}", file=sys.stderr)
    raise SystemExit(code)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def require_full_sha(git_sha: str) -> str:
    sha = (git_sha or "").strip().lower()
    if not FULL_SHA_RE.match(sha):
        die(
            "CD_GIT_SHA / --git-sha must be the exact 40-char lowercase hex "
            f"object id (got {git_sha!r})"
        )
    return sha


def parse_tag(tag: str) -> Tuple[str, str, str]:
    """Return (release_version, package_core, kind)."""
    raw = (tag or "").strip()
    m = TAG_RE.match(raw)
    if not m:
        die(f"tag {tag!r} must match vMAJOR.MINOR.PATCH[-prerelease]")
    core = m.group("core")
    pre = m.group("pre") or ""
    version = core + pre
    kind = "prerelease" if pre else "ga"
    if pre and not any(
        token in pre.lower() for token in ("-rc", "-alpha", "-beta", "-pre")
    ):
        kind = "prerelease"
    return version, core, kind


@dataclass(frozen=True)
class PackageVersions:
    cargo_workspace: str
    desktop_cargo: str
    tauri: str
    desktop_npm: str

    def unique(self) -> List[str]:
        return sorted(
            {
                self.cargo_workspace,
                self.desktop_cargo,
                self.tauri,
                self.desktop_npm,
            }
        )


def read_package_versions(repo_root: Path) -> PackageVersions:
    root = Path(repo_root)
    cargo = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))
    desktop_cargo = tomllib.loads(
        (root / "desktop" / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    )
    tauri = json.loads(
        (root / "desktop" / "src-tauri" / "tauri.conf.json").read_text(
            encoding="utf-8"
        )
    )
    npm = json.loads((root / "desktop" / "package.json").read_text(encoding="utf-8"))
    return PackageVersions(
        cargo_workspace=str(cargo["workspace"]["package"]["version"]),
        desktop_cargo=str(desktop_cargo["package"]["version"]),
        tauri=str(tauri["version"]),
        desktop_npm=str(npm["version"]),
    )


@dataclass(frozen=True)
class ReleaseIdentity:
    tag: str
    version: str
    package_version: str
    git_sha: str
    git_describe: str
    channel: str
    kind: str

    @property
    def prerelease(self) -> bool:
        return self.kind == "prerelease"

    @property
    def require_signed_updater(self) -> bool:
        return self.kind == "ga"


def check_identity(
    *,
    repo_root: Path,
    tag: str,
    git_sha: str,
    git_describe: str,
    channel: str,
    package_versions: Optional[PackageVersions] = None,
) -> ReleaseIdentity:
    sha = require_full_sha(git_sha)
    describe = (git_describe or "").strip()
    if not describe or describe in {"unknown", "0"}:
        die("CD_GIT_DESCRIBE / --git-describe is required and must not be a placeholder")
    ch = (channel or "").strip()
    if ch != CHANNEL_INSTALLED:
        die(f"release channel must be {CHANNEL_INSTALLED!r} (got {channel!r})")
    version, core, kind = parse_tag(tag)
    versions = package_versions or read_package_versions(Path(repo_root))
    distinct = versions.unique()
    if len(distinct) != 1:
        die(
            "Cargo/Tauri/npm package versions diverge: "
            f"workspace={versions.cargo_workspace} desktop_cargo={versions.desktop_cargo} "
            f"tauri={versions.tauri} npm={versions.desktop_npm}"
        )
    package_version = distinct[0]
    if package_version != core:
        die(
            f"package version {package_version} does not match tag core {core} "
            f"(tag {tag})"
        )
    if kind == "ga" and version != package_version:
        die(f"GA tag version {version} must equal package version {package_version}")
    return ReleaseIdentity(
        tag=tag.strip(),
        version=version,
        package_version=package_version,
        git_sha=sha,
        git_describe=describe,
        channel=ch,
        kind=kind,
    )


def preflight_signing(*, kind: str, has_tauri_key: bool) -> None:
    """Fail before any publishable release state exists for GA without the key.

    `has_tauri_key` is a boolean from the workflow (`secrets.X != ''`), never
    the secret value.
    """
    if kind == "ga" and not has_tauri_key:
        die(
            "GA requires updater signing prerequisite "
            "TAURI_SIGNING_PRIVATE_KEY (presence only; value is never read here). "
            "Refusing to create publishable release state."
        )


def test_signature(artifact: bytes, key: str = "fixture") -> str:
    digest = hashlib.sha256(key.encode("utf-8") + b"\0" + artifact).hexdigest()
    return f"{TEST_SIG_PREFIX}{digest}"


def looks_like_minisign(signature: str) -> bool:
    text = (signature or "").strip()
    if not text:
        return False
    return any(h in text for h in MINISIGN_HINTS) or text.startswith("dW50")


def verify_artifact_signature(
    artifact: bytes,
    signature: str,
    *,
    allow_test_sig: bool,
) -> None:
    sig = (signature or "").strip()
    if not sig or sig in {"unsigned", "missing", "TODO", "placeholder"}:
        die("updater signature is missing or a placeholder")
    if sig.startswith(TEST_SIG_PREFIX):
        if not allow_test_sig:
            die("test signatures are forbidden for production promote/publish")
        expected = test_signature(artifact)
        if sig != expected:
            die("test signature does not bind to this exact artifact digest")
        return
    if looks_like_minisign(sig):
        return
    die("unrecognized updater signature format")


@dataclass
class Asset:
    name: str
    path: Path
    sha256: str
    kind: str
    platform: Optional[str] = None


def infer_cli_platform(name: str) -> Optional[str]:
    for plat in REQUIRED_CLI:
        if f"-{plat}." in name or name.endswith(f"-{plat}.tar.gz") or name.endswith(
            f"-{plat}.zip"
        ):
            return plat
    return None


def infer_desktop_os(name: str) -> Optional[str]:
    lower = name.lower()
    if lower.endswith(".sig"):
        return infer_desktop_os(name[: -len(".sig")])
    if lower.endswith(".dmg") or lower.endswith(".app.tar.gz"):
        return "macos"
    if (
        lower.endswith(".msi")
        or lower.endswith(".msi.zip")
        or lower.endswith(".nsis.zip")
        or (lower.endswith(".exe") and infer_cli_platform(name) is None)
    ):
        return "windows"
    if (
        lower.endswith(".appimage")
        or lower.endswith(".appimage.tar.gz")
        or lower.endswith(".deb")
    ):
        return "linux"
    return None


def infer_updater_triple(name: str) -> Optional[str]:
    lower = name.lower()
    if lower.endswith(".sig"):
        return infer_updater_triple(name[: -len(".sig")])
    if lower.endswith(".app.tar.gz"):
        if "x64" in lower or "x86_64" in lower:
            return "darwin-x86_64"
        return "darwin-aarch64"
    if lower.endswith(".msi.zip") or lower.endswith(".exe.zip") or lower.endswith(
        ".nsis.zip"
    ):
        return "windows-x86_64"
    if lower.endswith(".appimage.tar.gz"):
        return "linux-x86_64"
    return None


def classify_name(name: str) -> Tuple[str, Optional[str]]:
    if name in METADATA_NAMES or name.startswith("build-info-"):
        return "metadata", None
    if name.startswith("contextdesk-") and (
        name.endswith(".tar.gz") or name.endswith(".zip")
    ):
        return "cli", infer_cli_platform(name)
    if name.endswith(".sig") or infer_updater_triple(name):
        kind = "updater"
        return kind, infer_desktop_os(name)
    desktop_os = infer_desktop_os(name)
    if desktop_os:
        return "desktop", desktop_os
    return "other", None


def collect_assets(directory: Path, *, skip_generated: bool = True) -> List[Asset]:
    assets: List[Asset] = []
    seen: Dict[str, Path] = {}
    for path in sorted(Path(directory).rglob("*")):
        if not path.is_file():
            continue
        if skip_generated and path.name in {
            "SHA256SUMS",
            "inventory.txt",
            "sbom.cdx.json",
            "release-manifest.json",
        }:
            continue
        kind, platform = classify_name(path.name)
        if path.name in seen:
            die(f"duplicate asset basename {path.name}: {seen[path.name]} and {path}")
        seen[path.name] = path
        assets.append(
            Asset(
                name=path.name,
                path=path,
                sha256=sha256_file(path),
                kind=kind,
                platform=platform,
            )
        )
    return assets


def versions_in_name(name: str) -> List[str]:
    return VERSION_TOKEN_RE.findall(name)


def detect_foreign_reuse(
    *,
    names: Sequence[str],
    urls: Sequence[str],
    identity: ReleaseIdentity,
    metadata_shas: Sequence[str],
) -> List[str]:
    errors: List[str] = []
    allowed_versions = {identity.version, identity.package_version}
    haystacks = list(names) + list(urls)
    for item in haystacks:
        for forbidden in FORBIDDEN_REUSE_TAGS:
            forbidden_ver = forbidden[1:] if forbidden.startswith("v") else forbidden
            if forbidden == identity.tag:
                continue
            if forbidden in item or (
                forbidden_ver in item and identity.version != forbidden_ver
            ):
                errors.append(
                    f"refuses to reuse {forbidden} assets/URLs on {identity.tag}: {item}"
                )
        for ver in versions_in_name(item):
            if ver not in allowed_versions and not item.endswith(".json"):
                # metadata files may mention schema versions; skip those
                if item in METADATA_NAMES:
                    continue
                errors.append(
                    f"asset/URL {item} carries foreign version {ver} "
                    f"(allowed {sorted(allowed_versions)})"
                )
    for meta_sha in metadata_shas:
        if meta_sha and meta_sha != identity.git_sha:
            errors.append(
                f"metadata git_sha {meta_sha} does not match exact identity "
                f"{identity.git_sha}"
            )
    return errors


def desktop_os_present(assets: Sequence[Asset]) -> Dict[str, List[str]]:
    found: Dict[str, List[str]] = {os_name: [] for os_name in REQUIRED_DESKTOP}
    for asset in assets:
        if asset.kind == "desktop" and asset.platform in found:
            found[asset.platform].append(asset.name)
    return found


def cli_platforms_present(assets: Sequence[Asset]) -> Dict[str, List[str]]:
    found: Dict[str, List[str]] = {p: [] for p in REQUIRED_CLI}
    for asset in assets:
        if asset.kind == "cli" and asset.platform in found:
            found[asset.platform].append(asset.name)
    return found


def require_complete_matrices(assets: Sequence[Asset]) -> None:
    desktop = desktop_os_present(assets)
    missing_desktop: List[str] = []
    if not any(n.endswith(".dmg") for n in desktop["macos"]):
        missing_desktop.append("macos(.dmg)")
    if not any(n.endswith(".msi") or n.endswith(".exe") for n in desktop["windows"]):
        missing_desktop.append("windows(.msi|.exe)")
    linux_names = desktop["linux"]
    if not any(n.endswith(".AppImage") or n.endswith(".appimage") for n in linux_names):
        missing_desktop.append("linux(.AppImage)")
    if not any(n.endswith(".deb") for n in linux_names):
        missing_desktop.append("linux(.deb)")
    cli = cli_platforms_present(assets)
    missing_cli = [p for p, names in cli.items() if not names]
    errors = []
    if missing_desktop:
        errors.append(f"incomplete desktop matrix: missing {missing_desktop}")
    if missing_cli:
        errors.append(f"incomplete CLI matrix: missing {missing_cli}")
    # duplicate platform archives
    for plat, names in cli.items():
        if len(names) > 1:
            errors.append(f"duplicate CLI archives for {plat}: {names}")
    if errors:
        die("; ".join(errors))


def collect_metadata_shas(directory: Path) -> List[str]:
    shas: List[str] = []
    for path in Path(directory).rglob("*.json"):
        if path.name in {"sbom.cdx.json", "latest.json"}:
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("git_sha"):
            shas.append(str(data["git_sha"]))
    return shas


def build_latest_json(
    *,
    identity: ReleaseIdentity,
    assets: Sequence[Asset],
    download_repo: str,
    allow_test_sig: bool,
) -> Dict[str, Any]:
    by_name = {a.name: a for a in assets}
    platforms: Dict[str, Dict[str, str]] = {}
    for asset in assets:
        if asset.kind != "updater" or asset.name.endswith(".sig"):
            continue
        triple = infer_updater_triple(asset.name)
        if not triple:
            die(f"cannot infer updater platform for {asset.name}")
        sig_name = f"{asset.name}.sig"
        if sig_name not in by_name:
            die(f"updater archive {asset.name} is missing sidecar {sig_name}")
        signature = by_name[sig_name].path.read_text(encoding="utf-8").strip()
        verify_artifact_signature(
            asset.path.read_bytes(), signature, allow_test_sig=allow_test_sig
        )
        url = (
            f"https://github.com/{download_repo}/releases/download/"
            f"{identity.tag}/{asset.name}"
        )
        platforms[triple] = {"signature": signature, "url": url}
    if not platforms:
        die("signed updater latest.json required but no updater archives were found")
    needed_os = {"macos": "darwin-", "windows": "windows-", "linux": "linux-"}
    present_os = set()
    for triple in platforms:
        for os_name, prefix in needed_os.items():
            if triple.startswith(prefix):
                present_os.add(os_name)
    missing = [os_name for os_name in REQUIRED_DESKTOP if os_name not in present_os]
    if missing:
        die(f"latest.json missing updater platforms for {missing}")
    return {
        "version": identity.package_version,
        "notes": f"ContextDesk {identity.tag} ({identity.git_sha})",
        "pub_date": utc_now(),
        "platforms": platforms,
    }


def verify_latest_json(
    data: Mapping[str, Any],
    *,
    assets: Sequence[Asset],
    identity: ReleaseIdentity,
    allow_test_sig: bool,
    download_repo: str,
) -> None:
    if not isinstance(data, Mapping) or "platforms" not in data:
        die("latest.json must be an object with platforms")
    names = {a.name for a in assets}
    by_name = {a.name: a for a in assets}
    platforms = data.get("platforms") or {}
    if not platforms:
        die("latest.json platforms is empty")
    for triple, spec in platforms.items():
        if not isinstance(spec, Mapping):
            die(f"latest.json platform {triple} is not an object")
        url = str(spec.get("url") or "")
        signature = str(spec.get("signature") or "")
        parsed = urlparse(url)
        if parsed.scheme != "https":
            die(f"latest.json URL must be https: {url}")
        parts = parsed.path.split("/")
        # /<owner>/<repo>/releases/download/<tag>/<file>
        try:
            rel_idx = parts.index("releases")
            download_word = parts[rel_idx + 1]
            url_tag = parts[rel_idx + 2]
            filename = parts[rel_idx + 3]
        except (ValueError, IndexError):
            die(f"latest.json URL is not a GitHub release download URL: {url}")
        if download_word != "download":
            die(f"latest.json URL must use /releases/download/, not {url}")
        if "/latest/" in parsed.path or url_tag == "latest":
            die(f"latest.json URL must bind to the exact tag, not /latest/: {url}")
        if url_tag != identity.tag:
            die(
                f"latest.json URL tag {url_tag} does not bind to {identity.tag}: {url}"
            )
        expected_prefix = f"/{download_repo}/releases/download/{identity.tag}/"
        if expected_prefix not in parsed.path:
            die(f"latest.json URL does not bind to {download_repo}@{identity.tag}: {url}")
        if filename not in names:
            die(f"latest.json URL filename {filename} is not a released asset")
        verify_artifact_signature(
            by_name[filename].path.read_bytes(),
            signature,
            allow_test_sig=allow_test_sig,
        )
        reuse_errs = detect_foreign_reuse(
            names=[filename],
            urls=[url],
            identity=identity,
            metadata_shas=[],
        )
        if reuse_errs:
            die("; ".join(reuse_errs))


def write_sha256sums(directory: Path, files: Sequence[Path]) -> Path:
    lines = []
    for path in sorted(files, key=lambda p: p.name):
        lines.append(f"{sha256_file(path)}  {path.name}\n")
    if not lines:
        die("SHA256SUMS would be empty")
    out = Path(directory) / "SHA256SUMS"
    out.write_text("".join(lines), encoding="utf-8")
    return out


def write_inventory(directory: Path, assets: Sequence[Asset]) -> Path:
    lines = [
        f"# ContextDesk release inventory",
        f"# generated {utc_now()}",
        "",
    ]
    for asset in sorted(assets, key=lambda a: a.name):
        plat = asset.platform or "-"
        lines.append(f"{asset.sha256}  {asset.kind}/{plat}  {asset.name}")
    out = Path(directory) / "inventory.txt"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def write_sbom(
    directory: Path, *, identity: ReleaseIdentity, assets: Sequence[Asset]
) -> Path:
    components = []
    for asset in sorted(assets, key=lambda a: a.name):
        components.append(
            {
                "type": "file",
                "name": asset.name,
                "version": identity.version,
                "hashes": [{"alg": "SHA-256", "content": asset.sha256}],
                "properties": [
                    {"name": "cd:kind", "value": asset.kind},
                    {"name": "cd:platform", "value": asset.platform or ""},
                ],
            }
        )
    sbom = {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "timestamp": utc_now(),
            "component": {
                "type": "application",
                "name": "contextdesk-release",
                "version": identity.version,
            },
            "properties": [
                {"name": "cd:git_sha", "value": identity.git_sha},
                {"name": "cd:git_describe", "value": identity.git_describe},
                {"name": "cd:channel", "value": identity.channel},
                {"name": "cd:draft_only", "value": "true"},
                {"name": "cd:auto_publish", "value": "false"},
                {"name": "cd:war_room", "value": WAR_ROOM_STATUS},
            ],
        },
        "components": components,
    }
    out = Path(directory) / "sbom.cdx.json"
    out.write_text(json.dumps(sbom, indent=2) + "\n", encoding="utf-8")
    return out


def write_manifest(
    directory: Path,
    *,
    identity: ReleaseIdentity,
    assets: Sequence[Asset],
    signed_updater: bool,
    promotable: bool,
) -> Path:
    desktop = {os_name: names for os_name, names in desktop_os_present(assets).items()}
    cli = {plat: names for plat, names in cli_platforms_present(assets).items()}
    manifest = {
        "schema": SCHEMA,
        "tag": identity.tag,
        "version": identity.version,
        "package_version": identity.package_version,
        "git_sha": identity.git_sha,
        "git_describe": identity.git_describe,
        "channel": identity.channel,
        "kind": identity.kind,
        "draft": True,
        "published": False,
        "auto_publish": False,
        "promotable": promotable,
        "required_desktop": list(REQUIRED_DESKTOP),
        "required_cli": list(REQUIRED_CLI),
        "desktop_found": {k: v for k, v in desktop.items()},
        "cli_found": {k: v for k, v in cli.items()},
        "assets": [
            {
                "name": a.name,
                "sha256": a.sha256,
                "kind": a.kind,
                "platform": a.platform,
            }
            for a in sorted(assets, key=lambda x: x.name)
        ],
        "checksums_file": "SHA256SUMS",
        "inventory_file": "inventory.txt",
        "sbom_file": "sbom.cdx.json",
        "updater": {
            "latest_json": "latest.json" if signed_updater else None,
            "signed": signed_updater,
            "required_for_ga": True,
        },
        "signing": {
            "updater": "signed" if signed_updater else "missing",
            "macos_notarization": SIGNING_POSTURE["macos_notarization"]["honest_status"],
            "windows_authenticode": SIGNING_POSTURE["windows_authenticode"][
                "honest_status"
            ],
            "secret_names": {
                "updater": SIGNING_POSTURE["updater"]["secret_names"],
                "macos_notarization": [],
                "windows_authenticode": [],
            },
        },
        "forbidden_reuse": list(FORBIDDEN_REUSE_TAGS),
        "war_room": WAR_ROOM_STATUS,
        "release_object": {
            "name": locked_release_name(identity),
            "prerelease": identity.prerelease,
            "clobber": False,
        },
    }
    out = Path(directory) / "release-manifest.json"
    out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return out


def assemble(
    directory: Path,
    *,
    identity: ReleaseIdentity,
    require_signed_updater: bool,
    allow_test_sig: bool,
    download_repo: str = DEFAULT_DOWNLOAD_REPO,
) -> Dict[str, Any]:
    directory = Path(directory)
    if not directory.is_dir():
        die(f"assemble directory not found: {directory}")
    assets = collect_assets(directory, skip_generated=True)
    if not assets:
        die(f"no assets in {directory}")
    reuse_errs = detect_foreign_reuse(
        names=[a.name for a in assets],
        urls=[],
        identity=identity,
        metadata_shas=collect_metadata_shas(directory),
    )
    if reuse_errs:
        die("; ".join(reuse_errs))
    require_complete_matrices(assets)

    signed = False
    latest_path = directory / "latest.json"
    if require_signed_updater or identity.kind == "ga":
        latest = build_latest_json(
            identity=identity,
            assets=assets,
            download_repo=download_repo,
            allow_test_sig=allow_test_sig,
        )
        latest_path.write_text(json.dumps(latest, indent=2) + "\n", encoding="utf-8")
        assets.append(
            Asset(
                name="latest.json",
                path=latest_path,
                sha256=sha256_file(latest_path),
                kind="metadata",
            )
        )
        verify_latest_json(
            latest,
            assets=assets,
            identity=identity,
            allow_test_sig=allow_test_sig,
            download_repo=download_repo,
        )
        signed = True
    elif latest_path.is_file():
        latest = json.loads(latest_path.read_text(encoding="utf-8"))
        verify_latest_json(
            latest,
            assets=assets + [
                Asset(
                    name="latest.json",
                    path=latest_path,
                    sha256=sha256_file(latest_path),
                    kind="metadata",
                )
            ],
            identity=identity,
            allow_test_sig=allow_test_sig,
            download_repo=download_repo,
        )
        signed = True

    if identity.kind == "ga" and not signed:
        die("GA assemble refused: signed latest.json is required")

    checksum_files = [a.path for a in assets if a.name != "SHA256SUMS"]
    write_sha256sums(directory, checksum_files)
    write_inventory(directory, assets)
    write_sbom(directory, identity=identity, assets=assets)
    promotable = True
    if identity.kind == "ga" and not signed:
        promotable = False
    manifest_path = write_manifest(
        directory,
        identity=identity,
        assets=assets,
        signed_updater=signed,
        promotable=promotable,
    )
    assert_draft_only(manifest_path)
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def assert_draft_only(manifest_path: Path) -> None:
    data = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if data.get("published") is True:
        die("release-manifest claims published=true — assemble/CI must stay draft-only")
    if data.get("draft") is not True:
        die("release-manifest.draft must be true")
    if data.get("auto_publish") is True:
        die("auto_publish must be false")
    if data.get("channel") != CHANNEL_INSTALLED:
        die("manifest channel must be installed")


def locked_release_name(identity: ReleaseIdentity) -> str:
    return f"ContextDesk {identity.tag}"


def locked_release_body(identity: ReleaseIdentity) -> str:
    return (
        f"ContextDesk {identity.tag}\n\n"
        f"Exact identity:\n"
        f"- git_sha: `{identity.git_sha}`\n"
        f"- git_describe: `{identity.git_describe}`\n"
        f"- channel: `{identity.channel}`\n"
        f"- package_version: `{identity.package_version}`\n"
        f"- release_version: `{identity.version}`\n\n"
        "This draft is assembled by the single `.github/workflows/release.yml` "
        "orchestration path. Desktop and CLI builder workflows upload Actions "
        "artifacts only and must not mutate title, body, or prerelease state.\n\n"
        "Apple notarization: not_configured.\n"
        "Windows Authenticode: not_configured.\n"
        "War Room: source-run / separately deployed today; not included in "
        "these desktop or CLI assets.\n\n"
        "Do not publish until `.github/workflows/release-promote.yml` validates "
        "the complete exact-SHA matrix. Never reuse v0.1.0-rc5 assets or "
        "another SHA.\n"
    )


@dataclass
class StoredAsset:
    name: str
    sha256: str
    size: int


@dataclass
class ReleaseObject:
    tag: str
    name: str
    body: str
    draft: bool
    prerelease: bool
    git_sha: str
    assets: Dict[str, StoredAsset] = field(default_factory=dict)

    @property
    def published(self) -> bool:
        return not self.draft


class MemoryReleaseStore:
    """In-memory GitHub Release stand-in for offline contract tests."""

    def __init__(self) -> None:
        self.releases: Dict[str, ReleaseObject] = {}

    def get(self, tag: str) -> Optional[ReleaseObject]:
        rel = self.releases.get(tag)
        if rel is None:
            return None
        # return a shallow copy so tests can observe rollback
        return ReleaseObject(
            tag=rel.tag,
            name=rel.name,
            body=rel.body,
            draft=rel.draft,
            prerelease=rel.prerelease,
            git_sha=rel.git_sha,
            assets=dict(rel.assets),
        )

    def create_draft(self, desired: ReleaseObject) -> ReleaseObject:
        existing = self.releases.get(desired.tag)
        if existing is None:
            stored = ReleaseObject(
                tag=desired.tag,
                name=desired.name,
                body=desired.body,
                draft=True,
                prerelease=desired.prerelease,
                git_sha=desired.git_sha,
                assets={},
            )
            self.releases[desired.tag] = stored
            return self.get(desired.tag)  # type: ignore[return-value]
        if (
            existing.name != desired.name
            or existing.body != desired.body
            or existing.prerelease != desired.prerelease
        ):
            raise ContractError(
                "refusing to clobber existing release title/body/prerelease "
                f"for {desired.tag}"
            )
        if existing.git_sha != desired.git_sha:
            raise ContractError(
                f"existing draft git_sha {existing.git_sha} != {desired.git_sha}"
            )
        return self.get(desired.tag)  # type: ignore[return-value]

    def attach(self, tag: str, name: str, sha256: str, size: int) -> None:
        rel = self.releases.get(tag)
        if rel is None:
            raise ContractError(f"no release for {tag}")
        if name in rel.assets:
            prev = rel.assets[name]
            if prev.sha256 != sha256:
                raise ContractError(
                    f"refusing to clobber asset {name} (existing {prev.sha256} "
                    f"!= {sha256})"
                )
            return
        rel.assets[name] = StoredAsset(name=name, sha256=sha256, size=size)

    def promote(self, tag: str) -> ReleaseObject:
        rel = self.releases.get(tag)
        if rel is None:
            raise ContractError(f"no release for {tag}")
        rel.draft = False
        return self.get(tag)  # type: ignore[return-value]


def create_or_verify_draft(
    store: MemoryReleaseStore, identity: ReleaseIdentity
) -> ReleaseObject:
    desired = ReleaseObject(
        tag=identity.tag,
        name=locked_release_name(identity),
        body=locked_release_body(identity),
        draft=True,
        prerelease=identity.prerelease,
        git_sha=identity.git_sha,
    )
    return store.create_draft(desired)


def attach_assembled_assets(
    store: MemoryReleaseStore, identity: ReleaseIdentity, directory: Path
) -> None:
    directory = Path(directory)
    manifest = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("git_sha") != identity.git_sha:
        raise ContractError("manifest git_sha does not match identity; refusing attach")
    for path in sorted(directory.iterdir()):
        if not path.is_file():
            continue
        store.attach(identity.tag, path.name, sha256_file(path), path.stat().st_size)


@dataclass
class PromoteResult:
    published: bool
    draft_unchanged: bool
    reason: str


def validate_promote_payload(
    *,
    identity: ReleaseIdentity,
    directory: Path,
    allow_test_sig: bool,
    download_repo: str = DEFAULT_DOWNLOAD_REPO,
) -> List[str]:
    errors: List[str] = []
    directory = Path(directory)
    manifest_path = directory / "release-manifest.json"
    if not manifest_path.is_file():
        return ["missing release-manifest.json"]
    try:
        assert_draft_only(manifest_path)
    except SystemExit as exc:
        errors.append(str(exc))
        return errors
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("git_sha") != identity.git_sha:
        errors.append(
            f"manifest git_sha {manifest.get('git_sha')} != expected {identity.git_sha}"
        )
    if manifest.get("tag") != identity.tag:
        errors.append(f"manifest tag {manifest.get('tag')} != {identity.tag}")
    if manifest.get("channel") != CHANNEL_INSTALLED:
        errors.append("manifest channel is not installed")
    if manifest.get("promotable") is not True:
        errors.append("manifest is not promotable")
    try:
        assets = collect_assets(directory, skip_generated=False)
        # drop generated metadata from matrix completeness by re-running assemble checks
        raw = collect_assets(directory, skip_generated=True)
        require_complete_matrices(raw)
        reuse_errs = detect_foreign_reuse(
            names=[a.name for a in assets],
            urls=[],
            identity=identity,
            metadata_shas=collect_metadata_shas(directory),
        )
        errors.extend(reuse_errs)
        latest_path = directory / "latest.json"
        if identity.kind == "ga":
            if not latest_path.is_file():
                errors.append("GA promote requires signed latest.json")
            else:
                latest = json.loads(latest_path.read_text(encoding="utf-8"))
                try:
                    verify_latest_json(
                        latest,
                        assets=raw
                        + [
                            Asset(
                                name="latest.json",
                                path=latest_path,
                                sha256=sha256_file(latest_path),
                                kind="metadata",
                            )
                        ],
                        identity=identity,
                        allow_test_sig=allow_test_sig,
                        download_repo=download_repo,
                    )
                except SystemExit as exc:
                    errors.append(str(exc) or "latest.json failed verification")
        elif latest_path.is_file():
            latest = json.loads(latest_path.read_text(encoding="utf-8"))
            try:
                verify_latest_json(
                    latest,
                    assets=raw
                    + [
                        Asset(
                            name="latest.json",
                            path=latest_path,
                            sha256=sha256_file(latest_path),
                            kind="metadata",
                        )
                    ],
                    identity=identity,
                    allow_test_sig=allow_test_sig,
                    download_repo=download_repo,
                )
            except SystemExit as exc:
                errors.append(str(exc) or "latest.json failed verification")
    except SystemExit as exc:
        errors.append(str(exc) or "promote validation failed")
    return errors


def promote(
    store: MemoryReleaseStore,
    *,
    identity: ReleaseIdentity,
    directory: Path,
    confirm: str,
    allow_test_sig: bool,
) -> PromoteResult:
    existing = store.get(identity.tag)
    if existing is None:
        return PromoteResult(
            published=False,
            draft_unchanged=True,
            reason="no draft exists; nothing published",
        )
    if existing.published:
        if existing.git_sha != identity.git_sha:
            return PromoteResult(
                published=True,
                draft_unchanged=True,
                reason="already published at a different SHA; refusing to mutate",
            )
        return PromoteResult(
            published=True,
            draft_unchanged=True,
            reason="already published at the exact SHA",
        )
    if confirm != "publish":
        return PromoteResult(
            published=False,
            draft_unchanged=True,
            reason="confirm_publish is not 'publish'; draft left unpublished",
        )
    errors = validate_promote_payload(
        identity=identity, directory=directory, allow_test_sig=allow_test_sig
    )
    if errors:
        return PromoteResult(
            published=False,
            draft_unchanged=True,
            reason="validation failed: " + "; ".join(errors),
        )
    if existing.git_sha != identity.git_sha:
        return PromoteResult(
            published=False,
            draft_unchanged=True,
            reason=(
                f"draft git_sha {existing.git_sha} != expected {identity.git_sha}; "
                "refusing to publish another SHA"
            ),
        )
    if (
        existing.name != locked_release_name(identity)
        or existing.body != locked_release_body(identity)
        or existing.prerelease != identity.prerelease
    ):
        return PromoteResult(
            published=False,
            draft_unchanged=True,
            reason="draft title/body/prerelease diverged from locked metadata",
        )
    store.promote(identity.tag)
    return PromoteResult(
        published=True, draft_unchanged=False, reason="published exact-SHA draft"
    )


# ---------------------------------------------------------------------------
# Optional live GitHub store (used only when GITHUB_TOKEN is set by CI).
# Tests never call this. Secret values are not logged.
# ---------------------------------------------------------------------------


class GitHubReleaseStore:
    def __init__(
        self,
        token: str,
        repo: str,
        api_url: str = "https://api.github.com",
    ) -> None:
        if not token:
            raise ContractError("GITHUB_TOKEN is required for live GitHub operations")
        if "/" not in repo:
            raise ContractError("GITHUB_REPOSITORY must be owner/name")
        self._token = token
        self.repo = repo
        self.api_url = api_url.rstrip("/")

    def _request(
        self,
        method: str,
        path: str,
        *,
        data: Optional[bytes] = None,
        content_type: str = "application/json",
    ) -> Tuple[int, Any]:
        url = path if path.startswith("http") else f"{self.api_url}{path}"
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        if data is not None:
            req.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
                payload = json.loads(raw.decode("utf-8")) if raw else {}
                return resp.status, payload
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                payload = json.loads(raw.decode("utf-8")) if raw else {}
            except json.JSONDecodeError:
                payload = {"message": "github error"}
            return exc.code, payload

    def get(self, tag: str) -> Optional[ReleaseObject]:
        code, payload = self._request("GET", f"/repos/{self.repo}/releases/tags/{tag}")
        if code == 404:
            return None
        if code >= 400:
            raise ContractError(f"GitHub get release failed ({code})")
        assets = {}
        for item in payload.get("assets") or []:
            assets[item["name"]] = StoredAsset(
                name=item["name"],
                sha256="",
                size=int(item.get("size") or 0),
            )
        return ReleaseObject(
            tag=payload.get("tag_name") or tag,
            name=payload.get("name") or "",
            body=payload.get("body") or "",
            draft=bool(payload.get("draft")),
            prerelease=bool(payload.get("prerelease")),
            git_sha=str((payload.get("target_commitish") or "")),
            assets=assets,
        )

    def create_draft(self, desired: ReleaseObject) -> ReleaseObject:
        existing = self.get(desired.tag)
        if existing is not None:
            if (
                existing.name != desired.name
                or existing.body != desired.body
                or existing.prerelease != desired.prerelease
            ):
                raise ContractError(
                    "refusing to clobber existing GitHub release title/body/prerelease"
                )
            return existing
        body = json.dumps(
            {
                "tag_name": desired.tag,
                "name": desired.name,
                "body": desired.body,
                "draft": True,
                "prerelease": desired.prerelease,
                "target_commitish": desired.git_sha,
            }
        ).encode("utf-8")
        code, payload = self._request(
            "POST", f"/repos/{self.repo}/releases", data=body
        )
        if code >= 400:
            raise ContractError(f"GitHub create draft failed ({code})")
        return self.get(desired.tag)  # type: ignore[return-value]

    def attach(self, tag: str, name: str, sha256: str, size: int) -> None:
        existing = self.get(tag)
        if existing is None:
            raise ContractError(f"no GitHub release for {tag}")
        if name in existing.assets:
            prev = existing.assets[name]
            if prev.size and prev.size != size:
                raise ContractError(
                    f"refusing to clobber existing GitHub asset {name}"
                )
            return
        # Upload is intentionally not implemented in this helper's unit path.
        # The workflow attaches via `gh release upload --clobber=false`.
        raise ContractError(
            "live asset upload is performed by gh release upload, not this store"
        )

    def promote(self, tag: str) -> ReleaseObject:
        code, payload = self._request("GET", f"/repos/{self.repo}/releases/tags/{tag}")
        if code >= 400:
            raise ContractError(f"GitHub get release failed ({code})")
        release_id = payload.get("id")
        patch = json.dumps({"draft": False}).encode("utf-8")
        code, _ = self._request(
            "PATCH", f"/repos/{self.repo}/releases/{release_id}", data=patch
        )
        if code >= 400:
            raise ContractError(f"GitHub promote failed ({code})")
        return self.get(tag)  # type: ignore[return-value]


def locked_release_object(identity: ReleaseIdentity) -> ReleaseObject:
    return ReleaseObject(
        tag=identity.tag,
        name=locked_release_name(identity),
        body=locked_release_body(identity),
        draft=True,
        prerelease=identity.prerelease,
        git_sha=identity.git_sha,
    )


# ---------------------------------------------------------------------------
# Workflow / docs structural helpers (offline text, no YAML parser required)
# ---------------------------------------------------------------------------


def workflow_mentions_release_mutation(text: str) -> bool:
    markers = (
        "softprops/action-gh-release",
        "tagName:",
        "releaseName:",
        "releaseBody:",
        "releaseDraft:",
        "includeUpdaterJson:",
        "gh release create",
        "gh release edit",
        "gh release delete",
    )
    return any(m in text for m in markers)


def load_workflow_text(repo_root: Path, name: str) -> str:
    return (Path(repo_root) / ".github" / "workflows" / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Synthetic fixture builder (offline, no real/private data)
# ---------------------------------------------------------------------------

GA_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
RC_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
FOREIGN_SHA = "cccccccccccccccccccccccccccccccccccccccc"


def _write(path: Path, data: bytes | str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        path.write_text(data, encoding="utf-8")
    else:
        path.write_bytes(data)
    return path


def write_build_info(directory: Path, identity: ReleaseIdentity) -> Path:
    payload = {
        "git_sha": identity.git_sha,
        "git_describe": identity.git_describe,
        "channel": identity.channel,
        "version": identity.version,
        "signing": {
            "macos_notarization": "not_configured",
            "windows_authenticode": "not_configured",
        },
    }
    return _write(
        directory / "build-info-linux-x64.json",
        json.dumps(payload, indent=2) + "\n",
    )


def populate_complete_matrix(
    directory: Path,
    *,
    identity: ReleaseIdentity,
    signed: bool,
    extra: Optional[Mapping[str, bytes]] = None,
) -> None:
    files = {
        f"ContextDesk_{identity.package_version}_aarch64.dmg": b"dmg-bytes",
        f"ContextDesk_{identity.package_version}_x64_en-US.msi": b"msi-bytes",
        f"ContextDesk_{identity.package_version}_amd64.AppImage": b"appimage-bytes",
        f"contextdesk_{identity.package_version}_amd64.deb": b"deb-bytes",
        f"contextdesk-{identity.version}-macos-arm64.tar.gz": b"cli-mac-arm",
        f"contextdesk-{identity.version}-macos-x64.tar.gz": b"cli-mac-x64",
        f"contextdesk-{identity.version}-linux-x64.tar.gz": b"cli-linux",
        f"contextdesk-{identity.version}-windows-x64.zip": b"cli-win",
    }
    updater = {
        "ContextDesk.app.tar.gz": b"macos-updater",
        f"ContextDesk_{identity.package_version}_x64_en-US.msi.zip": b"win-updater",
        f"ContextDesk_{identity.package_version}_amd64.AppImage.tar.gz": b"linux-updater",
    }
    for name, data in files.items():
        _write(directory / name, data)
    if signed:
        for name, data in updater.items():
            _write(directory / name, data)
            _write(directory / f"{name}.sig", test_signature(data))
    write_build_info(directory, identity)
    if extra:
        for name, data in extra.items():
            _write(directory / name, data)


def fixture_identity(
    *, tag: str = "v0.1.0", git_sha: str = GA_SHA, kind_describe: str = "v0.1.0"
) -> ReleaseIdentity:
    version, core, kind = parse_tag(tag)
    return ReleaseIdentity(
        tag=tag,
        version=version,
        package_version=core,
        git_sha=git_sha,
        git_describe=kind_describe,
        channel=CHANNEL_INSTALLED,
        kind=kind,
    )


def cmd_identity(args: argparse.Namespace) -> int:
    identity = check_identity(
        repo_root=Path(args.repo_root),
        tag=args.tag,
        git_sha=args.git_sha,
        git_describe=args.git_describe,
        channel=args.channel,
    )
    print(json.dumps(asdict(identity), indent=2))
    return 0


def cmd_preflight_signing(args: argparse.Namespace) -> int:
    has_key = str(args.has_tauri_key).lower() in {"1", "true", "yes"}
    preflight_signing(kind=args.kind, has_tauri_key=has_key)
    print("preflight-signing: ok")
    return 0


def cmd_assemble(args: argparse.Namespace) -> int:
    identity = ReleaseIdentity(
        tag=args.tag,
        version=parse_tag(args.tag)[0],
        package_version=parse_tag(args.tag)[1],
        git_sha=require_full_sha(args.git_sha),
        git_describe=args.git_describe,
        channel=args.channel,
        kind=parse_tag(args.tag)[2],
    )
    if args.check_repo:
        identity = check_identity(
            repo_root=Path(args.repo_root),
            tag=args.tag,
            git_sha=args.git_sha,
            git_describe=args.git_describe,
            channel=args.channel,
        )
    require_signed = str(args.require_signed_updater).lower() in {"1", "true", "yes"}
    allow_test = str(args.allow_test_sig).lower() in {"1", "true", "yes"}
    if identity.kind == "ga":
        require_signed = True
    manifest = assemble(
        Path(args.dir),
        identity=identity,
        require_signed_updater=require_signed,
        allow_test_sig=allow_test,
        download_repo=args.download_repo,
    )
    print(json.dumps({"ok": True, "promotable": manifest.get("promotable")}, indent=2))
    return 0


def cmd_assert_draft(args: argparse.Namespace) -> int:
    assert_draft_only(Path(args.manifest))
    print("assert-draft-only: ok")
    return 0


def cmd_emit_notes(args: argparse.Namespace) -> int:
    identity = ReleaseIdentity(
        tag=args.tag,
        version=parse_tag(args.tag)[0],
        package_version=parse_tag(args.tag)[1],
        git_sha=require_full_sha(args.git_sha),
        git_describe=args.git_describe,
        channel=args.channel,
        kind=parse_tag(args.tag)[2],
    )
    Path(args.output).write_text(locked_release_body(identity), encoding="utf-8")
    print(locked_release_name(identity))
    return 0


def cmd_validate_promote(args: argparse.Namespace) -> int:
    identity = check_identity(
        repo_root=Path(args.repo_root),
        tag=args.tag,
        git_sha=args.expected_git_sha,
        git_describe=args.git_describe,
        channel=CHANNEL_INSTALLED,
    )
    allow_test = str(args.allow_test_sig).lower() in {"1", "true", "yes"}
    errors = validate_promote_payload(
        identity=identity,
        directory=Path(args.dir),
        allow_test_sig=allow_test,
        download_repo=args.download_repo,
    )
    if errors:
        for err in errors:
            print(err, file=sys.stderr)
        return 1
    print("validate-promote: ok")
    return 0


def cmd_promote_local(args: argparse.Namespace) -> int:
    """Offline promote against a serialized MemoryReleaseStore snapshot.

    Used by tests. The GitHub workflow shells out to `gh` only after this
    validator returns published=false reasons or, with --confirm publish,
    after validation succeeds.
    """
    identity = fixture_identity(
        tag=args.tag, git_sha=args.expected_git_sha, kind_describe=args.git_describe
    )
    if args.check_repo:
        identity = check_identity(
            repo_root=Path(args.repo_root),
            tag=args.tag,
            git_sha=args.expected_git_sha,
            git_describe=args.git_describe,
            channel=CHANNEL_INSTALLED,
        )
    store = MemoryReleaseStore()
    if args.seed_draft:
        create_or_verify_draft(store, identity)
        attach_assembled_assets(store, identity, Path(args.dir))
    allow_test = str(args.allow_test_sig).lower() in {"1", "true", "yes"}
    result = promote(
        store,
        identity=identity,
        directory=Path(args.dir),
        confirm=args.confirm,
        allow_test_sig=allow_test,
    )
    print(json.dumps(asdict(result), indent=2))
    return 0 if (result.published or args.confirm != "publish") else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("identity")
    p.add_argument("--repo-root", default=".")
    p.add_argument("--tag", required=True)
    p.add_argument("--git-sha", required=True)
    p.add_argument("--git-describe", required=True)
    p.add_argument("--channel", default=CHANNEL_INSTALLED)
    p.set_defaults(func=cmd_identity)

    p = sub.add_parser("preflight-signing")
    p.add_argument("--kind", required=True, choices=("ga", "prerelease"))
    p.add_argument("--has-tauri-key", required=True)
    p.set_defaults(func=cmd_preflight_signing)

    p = sub.add_parser("assemble")
    p.add_argument("--dir", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--git-sha", required=True)
    p.add_argument("--git-describe", required=True)
    p.add_argument("--channel", default=CHANNEL_INSTALLED)
    p.add_argument("--repo-root", default=".")
    p.add_argument("--check-repo", action="store_true")
    p.add_argument("--require-signed-updater", default="false")
    p.add_argument("--allow-test-sig", default="false")
    p.add_argument("--download-repo", default=DEFAULT_DOWNLOAD_REPO)
    p.set_defaults(func=cmd_assemble)

    p = sub.add_parser("assert-draft-only")
    p.add_argument("--manifest", required=True)
    p.set_defaults(func=cmd_assert_draft)

    p = sub.add_parser("emit-notes")
    p.add_argument("--tag", required=True)
    p.add_argument("--git-sha", required=True)
    p.add_argument("--git-describe", required=True)
    p.add_argument("--channel", default=CHANNEL_INSTALLED)
    p.add_argument("--output", required=True)
    p.set_defaults(func=cmd_emit_notes)

    p = sub.add_parser("validate-promote")
    p.add_argument("--dir", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--expected-git-sha", required=True)
    p.add_argument("--git-describe", required=True)
    p.add_argument("--repo-root", default=".")
    p.add_argument("--allow-test-sig", default="false")
    p.add_argument("--download-repo", default=DEFAULT_DOWNLOAD_REPO)
    p.set_defaults(func=cmd_validate_promote)

    p = sub.add_parser("promote-local")
    p.add_argument("--dir", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--expected-git-sha", required=True)
    p.add_argument("--git-describe", default="v0.1.0")
    p.add_argument("--confirm", default="")
    p.add_argument("--seed-draft", action="store_true")
    p.add_argument("--allow-test-sig", default="false")
    p.add_argument("--check-repo", action="store_true")
    p.add_argument("--repo-root", default=".")
    p.set_defaults(func=cmd_promote_local)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
