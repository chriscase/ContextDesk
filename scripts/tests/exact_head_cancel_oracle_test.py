#!/usr/bin/env python3
"""Mutation / unit tests for scripts/lib/exact_head_cancel_oracle.py."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "lib"))

import exact_head_cancel_oracle as o  # noqa: E402


PROMPT = "ACCEPT_SLOW_PROVIDER_HANG probe for interrupt acceptance"


class CancelOracleTests(unittest.TestCase):
    def test_mutation_rc0_with_prompt_word_cancel_must_fail(self):
        """rc=0 + output contains the word cancel (from prompt) must not pass."""
        # Prompt deliberately includes "cancel" so a permissive substring oracle
        # would incorrectly pass; the strict oracle must reject.
        prompt = "please cancel this request ACCEPT_SLOW_PROVIDER_HANG"
        stdout = (
            '{"type":"done","ok":true,"session_id":"s1","final_text":""}\n'
            f'user said: {prompt}\n'
        )
        r = o.evaluate_cancel_outcome(
            rc=0, stdout=stdout, stderr="", user_prompt=prompt
        )
        self.assertFalse(r.ok, r.reason)
        # Either the successful-done branch or the bare exit-0 branch is fine;
        # both are hard rejections — never accept because the prompt said "cancel".
        self.assertTrue(
            "exit 0" in r.reason.lower() or "successful done" in r.reason.lower(),
            r.reason,
        )

    def test_reject_successful_done_even_with_cancel_stderr(self):
        r = o.evaluate_cancel_outcome(
            rc=0,
            stdout='{"type":"done","ok":true}\n',
            stderr="cancelling — waiting\ncancelled\n",
            user_prompt=PROMPT,
        )
        self.assertFalse(r.ok)

    def test_reject_rc_143_forced_term(self):
        r = o.evaluate_cancel_outcome(
            rc=143,
            stdout="",
            stderr="cancelling — waiting for the turn to wind down...\n",
            user_prompt=PROMPT,
        )
        self.assertFalse(r.ok)
        self.assertIn("143", r.reason)

    def test_reject_forced_escalation_flag_even_if_rc_130(self):
        r = o.evaluate_cancel_outcome(
            rc=130,
            stdout='{"type":"turn_completed","reason":"cancelled"}\n{"type":"done","ok":false}\n',
            stderr="cancelling — waiting for the turn to wind down...\nchat turn cancelled\n",
            user_prompt=PROMPT,
            forced_escalation=True,
        )
        self.assertFalse(r.ok)
        self.assertIn("escalation", r.reason.lower())

    def test_reject_rc_2_as_cancel(self):
        r = o.evaluate_cancel_outcome(
            rc=2,
            stdout="",
            stderr="error: unexpected argument\n",
            user_prompt=PROMPT,
        )
        self.assertFalse(r.ok)

    def test_accept_documented_130_with_cli_markers(self):
        r = o.evaluate_cancel_outcome(
            rc=130,
            stdout='{"type":"turn_completed","reason":"cancelled"}\n'
            '{"type":"error","code":"cancelled","message":"chat turn cancelled"}\n'
            '{"type":"done","ok":false}\n',
            stderr="cancelling — waiting for the turn to wind down...\n",
            user_prompt=PROMPT,
        )
        self.assertTrue(r.ok, r.reason)

    def test_reject_130_without_truthful_record(self):
        r = o.evaluate_cancel_outcome(
            rc=130,
            stdout='{"type":"done","ok":false}\n',
            stderr="something else failed\n",
            user_prompt=PROMPT,
        )
        self.assertFalse(r.ok)

    def test_prompt_echo_alone_cannot_qualify(self):
        # Even rc 130: if the only "cancel" text is the prompt echo and there
        # are no CLI markers / structured cancel records → fail.
        prompt = "user wants to cancel ACCEPT_SLOW_PROVIDER_HANG"
        r = o.evaluate_cancel_outcome(
            rc=130,
            stdout=f'{{"type":"text_delta","text":"{prompt}"}}\n{{"type":"done","ok":false}}\n',
            stderr="",
            user_prompt=prompt,
        )
        self.assertFalse(r.ok)


if __name__ == "__main__":
    unittest.main()
