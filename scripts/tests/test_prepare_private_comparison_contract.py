#!/usr/bin/env python3
"""Contract tests for the owner-only private comparison workspace helper."""

from __future__ import annotations

from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "prepare-private-triage-comparison.sh"
TEMP_ROOT = Path("/private/tmp") if Path("/private/tmp").is_dir() else Path("/tmp")


class PrivateComparisonWorkspaceTests(unittest.TestCase):
    def test_rejected_destination_is_not_created(self) -> None:
        with tempfile.TemporaryDirectory(prefix="contextdesk-rejected-", dir=REPO_ROOT) as parent:
            rejected = Path(parent) / "must-not-exist"
            result = subprocess.run(
                [str(SCRIPT), str(rejected)],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 2)
            self.assertFalse(rejected.exists())

    def test_safe_workspace_is_owner_only_and_contains_only_templates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="contextdesk-private-base-", dir=TEMP_ROOT) as base:
            result = subprocess.run(
                [str(SCRIPT), base],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=True,
            )
            workspace = Path(result.stdout.splitlines()[1])
            self.assertEqual(stat.S_IMODE(workspace.stat().st_mode), 0o700)
            self.assertEqual(
                sorted(path.name for path in workspace.iterdir()),
                [
                    "01-experiment-package.json",
                    "02-external-chat-transcript.json",
                    "03-contextdesk-programmatic-trace.json",
                    "04-gold-reference-structure-only.json",
                ],
            )
            for path in workspace.iterdir():
                self.assertTrue(path.is_file())
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
