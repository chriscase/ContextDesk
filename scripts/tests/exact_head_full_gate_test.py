#!/usr/bin/env python3
"""Structural / mutation tests for the full acceptance gate.

Proves a missing or failed required command cannot yield FULL_GATE_PASS.
Does not re-implement the gate shell — drives scripts/lib/exact_head_full_gate.py
and checks the shell script references every required step.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
import sys

sys.path.insert(0, str(ROOT / "scripts" / "lib"))

from exact_head_full_gate import (  # noqa: E402
    REQUIRED_STEPS,
    StepResult,
    evaluate_full_gate,
    rehearsal_pass_alone_is_not_full_gate,
    required_step_ids,
)


class FullGateTests(unittest.TestCase):
    def test_all_success_is_full_gate_pass(self):
        results = [
            StepResult(step_id=sid, exit_code=0, present=True)
            for sid, _ in REQUIRED_STEPS
        ]
        v = evaluate_full_gate(results)
        self.assertTrue(v.full_gate_pass, v.reason)
        self.assertIn("FULL_GATE_PASS", v.reason)

    def test_missing_required_step_cannot_pass(self):
        # Drop consolidator step entirely.
        results = [
            StepResult(step_id=sid, exit_code=0, present=True)
            for sid, _ in REQUIRED_STEPS
            if sid != "exact_head_cli_acceptance"
        ]
        v = evaluate_full_gate(results)
        self.assertFalse(v.full_gate_pass)
        self.assertEqual(v.first_failure, "exact_head_cli_acceptance")
        self.assertIn("missing", v.reason.lower())

    def test_failed_required_step_cannot_pass(self):
        results = []
        for sid, _ in REQUIRED_STEPS:
            code = 1 if sid == "chat_cancellation" else 0
            results.append(StepResult(step_id=sid, exit_code=code, present=True))
        v = evaluate_full_gate(results)
        self.assertFalse(v.full_gate_pass)
        self.assertEqual(v.first_failure, "chat_cancellation")
        self.assertIn("failed", v.reason.lower())

    def test_rehearsal_pass_alone_is_not_full_gate(self):
        results = [
            StepResult(step_id="exact_head_cli_acceptance", exit_code=0, present=True)
        ]
        self.assertTrue(rehearsal_pass_alone_is_not_full_gate(results))
        v = evaluate_full_gate(results)
        self.assertFalse(v.full_gate_pass)

    def test_present_false_counts_as_missing(self):
        results = [
            StepResult(
                step_id=sid,
                exit_code=0,
                present=(sid != "identity_unit"),
            )
            for sid, _ in REQUIRED_STEPS
        ]
        # present=False for identity_unit → missing
        results = [
            StepResult(step_id="identity_unit", exit_code=0, present=False),
            *[
                StepResult(step_id=sid, exit_code=0, present=True)
                for sid, _ in REQUIRED_STEPS
                if sid != "identity_unit"
            ],
        ]
        v = evaluate_full_gate(results)
        self.assertFalse(v.full_gate_pass)
        self.assertEqual(v.first_failure, "identity_unit")

    def test_shell_script_references_every_required_step(self):
        """Structural: full gate shell must invoke each required step id/cmd."""
        sh = (ROOT / "scripts" / "exact_head_full_gate.sh").read_text(encoding="utf-8")
        self.assertIn("FULL_GATE_PASS", sh)
        self.assertIn("REHEARSAL_PASS", sh)
        self.assertIn("exact_head_full_gate", sh)
        for sid, cmd in REQUIRED_STEPS:
            self.assertIn(sid, sh, f"gate shell missing step_id {sid}")
            # Core of the command should appear (not necessarily identical quoting).
            token = cmd.split()[0]
            if token.endswith(".sh"):
                self.assertIn("exact_head_cli_acceptance.sh", sh)
            elif "exact_head_identity_test" in cmd:
                self.assertIn("exact_head_identity_test.py", sh)
            elif "exact_head_cancel_oracle_test" in cmd:
                self.assertIn("exact_head_cancel_oracle_test.py", sh)
            elif "exact_head_timezone_utc_lab" in cmd:
                self.assertIn("exact_head_timezone_utc_lab", sh)
            elif "chat_cancellation" in cmd:
                self.assertIn("chat_cancellation", sh)
            elif "cli_activity_parity" in cmd:
                self.assertIn("cli_activity_parity", sh)
            elif "cli_public_acceptance_lab" in cmd:
                self.assertIn("cli_public_acceptance_lab", sh)
                self.assertIn("full_path", sh)
            elif "desktop/src-tauri" in cmd:
                self.assertIn("desktop_tauri_tests", sh)
                self.assertIn("desktop/src-tauri/Cargo.toml", sh)

    def test_required_steps_are_stable_and_nonempty(self):
        ids = required_step_ids()
        self.assertGreaterEqual(len(ids), 7)
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
