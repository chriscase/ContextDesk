#!/usr/bin/env python3
"""Adversarial unit tests for scripts/lib/exact_head_identity.py.

Drives the real module — no reimplementation of the gate inside the test.
"""

from __future__ import annotations

import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

import exact_head_identity as ehi  # noqa: E402


FULL = "a" * 40
OTHER = "b" * 40


class ExactHeadIdentityTests(unittest.TestCase):
    def test_normalize_rejects_partial_and_non_hex(self):
        with self.assertRaises(ehi.IdentityError):
            ehi.normalize_full_sha("deadbeef")  # too short
        with self.assertRaises(ehi.IdentityError):
            ehi.normalize_full_sha("not-a-sha")
        with self.assertRaises(ehi.IdentityError):
            ehi.normalize_full_sha("")
        self.assertEqual(ehi.normalize_full_sha(FULL.upper()), FULL)

    def test_short_sha_prefix(self):
        self.assertEqual(ehi.short_sha(FULL, 12), "a" * 12)

    def test_stale_binary_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            binary = td_path / "contextdesk"
            binary.write_text("fake-binary\n", encoding="utf-8")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            ehi.write_stamp(binary, OTHER)
            with self.assertRaises(ehi.IdentityError) as ctx:
                ehi.require_matching_identity(binary, FULL)
            self.assertIn("STALE BINARY", str(ctx.exception))

    def test_missing_stamp_rejected_even_if_executable(self):
        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / "contextdesk"
            binary.write_text("x", encoding="utf-8")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            with self.assertRaises(ehi.IdentityError) as ctx:
                ehi.require_matching_identity(binary, FULL)
            self.assertIn("no exact-head stamp", str(ctx.exception))

    def test_missing_binary_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / "does-not-exist"
            with self.assertRaises(ehi.IdentityError) as ctx:
                ehi.require_matching_identity(binary, FULL)
            self.assertIn("missing", str(ctx.exception).lower())

    def test_matching_stamp_passes(self):
        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / "contextdesk"
            binary.write_text("ok", encoding="utf-8")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            ehi.write_stamp(binary, FULL)
            info = ehi.require_matching_identity(binary, FULL)
            self.assertTrue(info.matches)
            self.assertEqual(info.stamp_sha, FULL)

    def test_incorrect_sha_identity_on_write_and_check(self):
        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / "contextdesk"
            binary.write_text("ok", encoding="utf-8")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            with self.assertRaises(ehi.IdentityError):
                ehi.write_stamp(binary, "short")
            ehi.write_stamp(binary, FULL)
            with self.assertRaises(ehi.IdentityError):
                ehi.require_matching_identity(binary, OTHER)

    def test_unsafe_path_rejected(self):
        with self.assertRaises(ehi.IdentityError):
            ehi.is_safe_binary_path(Path("evil;rm -rf /"))
        with self.assertRaises(ehi.IdentityError):
            ehi.is_safe_binary_path(Path("a\nb"))
        with self.assertRaises(ehi.IdentityError):
            ehi.is_safe_binary_path(Path("foo/../etc/passwd"))
        # Empty fspath
        with self.assertRaises(ehi.IdentityError):
            ehi.is_safe_binary_path(Path())

    def test_misleading_success_blocked(self):
        """A binary that merely exists must not qualify as acceptance success."""
        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / "contextdesk"
            binary.write_text("stale", encoding="utf-8")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            # Exists + executable but no stamp → not a pass.
            self.assertTrue(binary.exists())
            with self.assertRaises(ehi.IdentityError) as ctx:
                ehi.claim_success_without_identity(binary, FULL)
            self.assertIn("misleading success", str(ctx.exception).lower())

    def test_corrupt_empty_stamp_fail_closed(self):
        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / "contextdesk"
            binary.write_text("x", encoding="utf-8")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            stamp = ehi.stamp_path_for(binary)
            stamp.write_text("\n", encoding="utf-8")
            with self.assertRaises(ehi.IdentityError):
                ehi.read_stamp(binary)

    def test_cli_check_subcommand_exit_codes(self):
        import subprocess

        with tempfile.TemporaryDirectory() as td:
            binary = Path(td) / "contextdesk"
            binary.write_text("x", encoding="utf-8")
            binary.chmod(binary.stat().st_mode | stat.S_IXUSR)
            py = ROOT / "scripts" / "lib" / "exact_head_identity.py"
            # Missing stamp → exit 2
            r = subprocess.run(
                [sys.executable, str(py), "check", "--binary", str(binary), "--expected-sha", FULL],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r.returncode, 2)
            self.assertIn("exact_head_fail", r.stderr)
            # Matching stamp → 0
            ehi.write_stamp(binary, FULL)
            r2 = subprocess.run(
                [sys.executable, str(py), "check", "--binary", str(binary), "--expected-sha", FULL],
                capture_output=True,
                text=True,
            )
            self.assertEqual(r2.returncode, 0)
            self.assertIn("exact_head_ok", r2.stdout)

    def test_embedded_runtime_identity_prefix_and_reject(self):
        short = FULL[:12]
        self.assertTrue(ehi.embedded_git_sha_matches(short, FULL))
        self.assertTrue(ehi.embedded_git_sha_matches(FULL, FULL))
        with self.assertRaises(ehi.IdentityError):
            ehi.require_embedded_runtime_identity(
                embedded_git_sha=None, expected_full_sha=FULL
            )
        with self.assertRaises(ehi.IdentityError):
            ehi.require_embedded_runtime_identity(
                embedded_git_sha="c" * 12, expected_full_sha=FULL
            )
        self.assertEqual(
            ehi.require_embedded_runtime_identity(
                embedded_git_sha=short, expected_full_sha=FULL
            ),
            short,
        )

    def test_parse_capabilities_git_sha(self):
        doc = (
            '{"schema_version":1,"ok":true,"data":{"git_sha":"'
            + FULL[:12]
            + '","cli_version":"0.1.0"}}'
        )
        self.assertEqual(ehi.parse_capabilities_git_sha(doc), FULL[:12])
        self.assertIsNone(
            ehi.parse_capabilities_git_sha(
                '{"ok":true,"data":{"cli_version":"0.1.0"}}'
            )
        )


if __name__ == "__main__":
    unittest.main()
