#!/usr/bin/env python3
"""Exact-head binary identity for CLI acceptance (scripts/docs/tests only).

Prevents a pre-existing target/debug (or release) binary from silently
qualifying an acceptance run. Identity is the **full Git SHA** of the worktree
plus an optional stamp file written next to the binary after a deliberate build.

This module is pure and offline-testable: no network, no cargo, no product
runtime. Scripts call it before any “pass” path that executes `contextdesk`.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
# Short form embedded by crates/cd-core/build.rs (`rev-parse --short=12`).
SHORT_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


class IdentityError(Exception):
    """Fail-closed identity / path error (never a silent pass)."""


@dataclass(frozen=True)
class BinaryIdentity:
    """Resolved identity for a candidate binary."""

    path: Path
    expected_full_sha: str
    stamp_sha: Optional[str]
    binary_exists: bool
    binary_executable: bool

    @property
    def matches(self) -> bool:
        return (
            self.binary_exists
            and self.binary_executable
            and self.stamp_sha is not None
            and self.stamp_sha == self.expected_full_sha
        )


def normalize_full_sha(raw: str) -> str:
    """Normalize and validate a full 40-char hex SHA."""
    s = (raw or "").strip().lower()
    if not FULL_SHA_RE.match(s):
        raise IdentityError(
            f"expected full 40-char git SHA, got {raw!r} "
            "(refusing partial/incorrect identity as a pass)"
        )
    return s


def short_sha(full: str, n: int = 12) -> str:
    """Prefix used by cd-core build_identity embedding."""
    full = normalize_full_sha(full)
    if n < 7 or n > 40:
        raise IdentityError(f"invalid short-sha length {n}")
    return full[:n]


def stamp_path_for(binary: Path) -> Path:
    """Sidecar stamp path: `<binary>.exact-head-sha`."""
    return Path(str(binary) + ".exact-head-sha")


def is_safe_binary_path(path: Path, *, repo_root: Optional[Path] = None) -> None:
    """Refuse unsafe or empty paths that could mislead success."""
    raw_s = os.fspath(path)
    if not isinstance(raw_s, str) or not raw_s.strip():
        raise IdentityError("binary path is empty")
    # Path() / Path("") normalize to "."; refuse that placeholder.
    if path == Path() or raw_s in (".", "./"):
        raise IdentityError("binary path is empty")
    # Refuse shell metacharacters / path tricks used to confuse callers.
    if any(ch in raw_s for ch in ("\n", "\r", "\0", ";", "|", "&", "`", "$")):
        raise IdentityError(f"unsafe characters in binary path: {raw_s!r}")
    # Refuse `..` segments that smuggle escapes (including under CARGO_TARGET_DIR).
    if ".." in path.parts:
        raise IdentityError(f"binary path escapes via '..': {raw_s}")
    _ = repo_root  # reserved for future containment checks


def read_stamp(binary: Path) -> Optional[str]:
    """Read stamp file; return None if missing; raise if corrupt."""
    stamp = stamp_path_for(binary)
    if not stamp.is_file():
        return None
    text = stamp.read_text(encoding="utf-8").strip()
    if not text:
        raise IdentityError(f"empty identity stamp: {stamp}")
    return normalize_full_sha(text)


def write_stamp(binary: Path, full_sha: str) -> Path:
    """Write stamp after a deliberate build of this checkout."""
    full = normalize_full_sha(full_sha)
    stamp = stamp_path_for(binary)
    stamp.parent.mkdir(parents=True, exist_ok=True)
    stamp.write_text(full + "\n", encoding="utf-8")
    return stamp


def git_full_sha(repo_root: Path) -> str:
    """Return `git rev-parse HEAD` for the worktree (must be full SHA)."""
    try:
        out = subprocess.check_output(
            ["git", "-C", str(repo_root), "rev-parse", "HEAD"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        raise IdentityError(f"cannot resolve git HEAD in {repo_root}: {e}") from e
    return normalize_full_sha(out)


def inspect_binary(
    binary: Path,
    expected_full_sha: str,
    *,
    repo_root: Optional[Path] = None,
) -> BinaryIdentity:
    """Inspect candidate binary + stamp against expected full SHA."""
    expected = normalize_full_sha(expected_full_sha)
    is_safe_binary_path(binary, repo_root=repo_root)
    exists = binary.is_file()
    executable = exists and os.access(binary, os.X_OK)
    stamp = None
    if exists:
        try:
            stamp = read_stamp(binary)
        except IdentityError:
            stamp = None  # corrupt stamp treated as no identity (fail closed)
    return BinaryIdentity(
        path=binary,
        expected_full_sha=expected,
        stamp_sha=stamp,
        binary_exists=exists,
        binary_executable=executable,
    )


def require_matching_identity(
    binary: Path,
    expected_full_sha: str,
    *,
    repo_root: Optional[Path] = None,
) -> BinaryIdentity:
    """Fail closed unless binary exists, is executable, and stamp == HEAD."""
    info = inspect_binary(binary, expected_full_sha, repo_root=repo_root)
    if not info.binary_exists:
        raise IdentityError(f"binary missing: {binary}")
    if not info.binary_executable:
        raise IdentityError(f"binary not executable: {binary}")
    if info.stamp_sha is None:
        raise IdentityError(
            f"no exact-head stamp for {binary} "
            f"(expected {info.expected_full_sha[:12]}…); "
            "rebuild with scripts/lib/exact_head_binary.sh ensure_exact_head_binary"
        )
    if info.stamp_sha != info.expected_full_sha:
        raise IdentityError(
            f"STALE BINARY: stamp={info.stamp_sha[:12]}… "
            f"worktree={info.expected_full_sha[:12]}… path={binary} — "
            "refusing to qualify acceptance"
        )
    return info


def claim_success_without_identity(
    binary: Path,
    expected_full_sha: str,
) -> None:
    """Adversarial helper: prove a naive 'exists => pass' check is insufficient.

    Raises IdentityError when a binary exists but does not match HEAD — callers
    must treat this as the correct fail-closed outcome (not success).
    """
    info = inspect_binary(binary, expected_full_sha)
    if info.binary_exists and not info.matches:
        raise IdentityError(
            "misleading success blocked: binary exists but identity does not match HEAD"
        )
    if info.matches:
        return
    raise IdentityError("binary not proven for HEAD")


def content_fingerprint(path: Path, *, limit: int = 1_048_576) -> str:
    """Optional content hash (not used for SHA gate; for tests only)."""
    h = hashlib.sha256()
    with path.open("rb") as f:
        remaining = limit
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            h.update(chunk)
            remaining -= len(chunk)
    return h.hexdigest()


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    import sys

    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    p_check = sub.add_parser("check", help="require matching stamp vs expected SHA")
    p_check.add_argument("--binary", type=Path, required=True)
    p_check.add_argument("--expected-sha", required=True)
    p_check.add_argument("--repo-root", type=Path, default=None)

    p_write = sub.add_parser("write-stamp", help="write stamp after deliberate build")
    p_write.add_argument("--binary", type=Path, required=True)
    p_write.add_argument("--sha", required=True)

    p_git = sub.add_parser("git-sha", help="print full HEAD SHA for a repo")
    p_git.add_argument("--repo-root", type=Path, required=True)

    args = p.parse_args(argv)
    try:
        if args.cmd == "check":
            require_matching_identity(
                args.binary, args.expected_sha, repo_root=args.repo_root
            )
            print(f"exact_head_ok sha={normalize_full_sha(args.expected_sha)}")
            return 0
        if args.cmd == "write-stamp":
            path = write_stamp(args.binary, args.sha)
            print(f"wrote {path}")
            return 0
        if args.cmd == "git-sha":
            print(git_full_sha(args.repo_root))
            return 0
    except IdentityError as e:
        print(f"exact_head_fail: {e}", file=sys.stderr)
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
