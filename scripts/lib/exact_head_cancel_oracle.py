#!/usr/bin/env python3
"""Strict cancellation oracle for exact-head CLI acceptance.

Documents the only accepted outcome for a rehearsal cancel step:

* exit code **130** (`ExitCategory::Cancelled`)
* operator-facing cancel announcement from the CLI (stderr ``cancelling`` /
  ``cancelled``), **not** the user prompt text
* terminal JSONL/activity that is truthful cancel — never ``done`` with
  ``ok: true``

Explicit rejections:

* ``rc == 0`` with a successful ``done`` record (even if output mentions cancel)
* ``rc == 143`` (SIGTERM / forced kill) — cleanup may use TERM, but that is
  **BLOCK**, never acceptance
* ``rc == 2`` unless independently proven as documented cancellation (we do
  **not** treat clap usage-exit 2 as cancel)
* Substring matches that only appear because the **user prompt** was echoed

This module is pure and unit-testable; the consolidator shells into it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Optional


# Documented cancelled category (docs/CLI.md / ExitCategory::Cancelled).
DOCUMENTED_CANCEL_EXIT = 130

# Phrases the *CLI* prints on cooperative interrupt (not user content).
CLI_CANCEL_MARKERS = (
    "cancelling",  # chat.rs: "cancelling — waiting for the turn to wind down..."
    "chat turn cancelled",
)

# Terminal success markers that must not appear as a clean accept after cancel.
SUCCESS_DONE_OK_RE = re.compile(
    r'"type"\s*:\s*"done"[^}\n]*"ok"\s*:\s*true|"ok"\s*:\s*true[^}\n]*"type"\s*:\s*"done"',
    re.I,
)
TURN_COMPLETED_CANCELLED_RE = re.compile(
    r'"type"\s*:\s*"turn_completed"[^}\n]*"reason"\s*:\s*"cancelled"'
    r'|"reason"\s*:\s*"cancelled"',
    re.I,
)
ACTIVITY_CANCELLED_RE = re.compile(
    r'"status"\s*:\s*"cancelled"|turn completed[^\n]*cancel|"type"\s*:\s*"activity"[^\n]*cancel',
    re.I,
)


class CancelOracleError(Exception):
    """Cancel path failed the strict oracle (BLOCK)."""


@dataclass(frozen=True)
class CancelOracleResult:
    ok: bool
    reason: str
    rc: int


def _strip_prompt_echo(text: str, prompt: str) -> str:
    """Remove the user prompt string so oracle cannot pass on echoed words."""
    if not prompt:
        return text
    # Case-fold removal of full prompt; also drop long shared substrings.
    out = text
    for piece in (prompt, prompt.lower(), prompt.upper()):
        out = out.replace(piece, "")
    # Drop individual prompt tokens longer than 4 chars (avoid nuking "chat").
    for tok in re.findall(r"[A-Za-z_]{5,}", prompt):
        out = re.sub(re.escape(tok), "", out, flags=re.I)
    return out


def parse_jsonl_types(stdout: str) -> list[dict]:
    rows = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def has_successful_done(stdout: str) -> bool:
    if SUCCESS_DONE_OK_RE.search(stdout):
        return True
    for row in parse_jsonl_types(stdout):
        if row.get("type") == "done" and row.get("ok") is True:
            return True
    return False


def has_truthful_cancel_terminal(stdout: str, stderr: str) -> bool:
    """Host-facing cancel evidence independent of the user prompt."""
    if TURN_COMPLETED_CANCELLED_RE.search(stdout):
        return True
    if ACTIVITY_CANCELLED_RE.search(stdout):
        return True
    for row in parse_jsonl_types(stdout):
        if row.get("type") == "turn_completed" and row.get("reason") == "cancelled":
            return True
        if row.get("type") == "done" and row.get("ok") is False:
            # Prefer explicit cancelled reason if present on sibling lines.
            pass
        if row.get("type") == "error" and str(row.get("code", "")).lower() in (
            "cancelled",
            "cancel",
        ):
            return True
        if row.get("type") == "activity" and str(row.get("status", "")).lower() == "cancelled":
            return True
    # CLI stderr announcement (chat renderer / CliError path).
    err_l = stderr.lower()
    if any(m in err_l for m in CLI_CANCEL_MARKERS):
        return True
    if "cancelled" in err_l and "cancelling" in err_l:
        return True
    return False


def evaluate_cancel_outcome(
    *,
    rc: int,
    stdout: str,
    stderr: str,
    user_prompt: str,
    forced_escalation: bool = False,
) -> CancelOracleResult:
    """Return ok=True only for documented cooperative cancellation."""
    stdout = stdout or ""
    stderr = stderr or ""
    prompt = user_prompt or ""

    # 1) Forced TERM / kill path is always BLOCK for acceptance.
    if forced_escalation:
        return CancelOracleResult(
            False,
            "BLOCK: forced termination/escalation was required "
            f"(rc={rc}); not cooperative cancel exit 130",
            rc,
        )
    if rc == 143:
        return CancelOracleResult(
            False,
            "BLOCK: exit 143 (SIGTERM) is forced cleanup, not documented cancel (130)",
            rc,
        )

    # 2) Successful done is never cancel acceptance.
    if has_successful_done(stdout):
        return CancelOracleResult(
            False,
            "BLOCK: successful done (ok:true) is not cancellation",
            rc,
        )
    if rc == 0:
        return CancelOracleResult(
            False,
            "BLOCK: exit 0 cannot be documented cancellation (need 130)",
            rc,
        )

    # 3) Exit 2 is clap usage / generic unless we refuse it entirely for cancel.
    if rc == 2:
        return CancelOracleResult(
            False,
            "BLOCK: exit 2 is not treated as documented cancellation "
            "(need ExitCategory::Cancelled = 130)",
            rc,
        )

    # 4) Must be documented cancel exit.
    if rc != DOCUMENTED_CANCEL_EXIT:
        return CancelOracleResult(
            False,
            f"BLOCK: expected exit {DOCUMENTED_CANCEL_EXIT} (cancelled), got {rc}",
            rc,
        )

    # 5) Truthful cancel evidence with prompt echo stripped from the search
    #    space used for soft "cancel" words — CLI markers checked on raw stderr.
    if not has_truthful_cancel_terminal(stdout, stderr):
        # Also check stripped bodies so prompt word "cancel" cannot rescue us.
        stripped_out = _strip_prompt_echo(stdout, prompt)
        stripped_err = _strip_prompt_echo(stderr, prompt)
        if not has_truthful_cancel_terminal(stripped_out, stripped_err):
            return CancelOracleResult(
                False,
                "BLOCK: exit 130 without CLI cancel announcement or "
                "cancelled terminal JSONL/activity record",
                rc,
            )

    # 6) Guard: if the *only* cancel evidence is the prompt substring, fail.
    #    (has_truthful_cancel_terminal already requires CLI markers / structured
    #    records; double-check we did not rely on prompt alone.)
    err_no_prompt = _strip_prompt_echo(stderr, prompt)
    out_no_prompt = _strip_prompt_echo(stdout, prompt)
    if (
        "cancel" in (stdout + stderr).lower()
        and "cancel" not in (out_no_prompt + err_no_prompt).lower()
        and not TURN_COMPLETED_CANCELLED_RE.search(stdout)
        and not any(m in stderr.lower() for m in CLI_CANCEL_MARKERS)
    ):
        return CancelOracleResult(
            False,
            "BLOCK: cancel evidence was only the echoed user prompt",
            rc,
        )

    return CancelOracleResult(True, "cooperative cancel exit 130 with truthful record", rc)


def require_cancel_outcome(
    *,
    rc: int,
    stdout: str,
    stderr: str,
    user_prompt: str,
    forced_escalation: bool = False,
) -> CancelOracleResult:
    result = evaluate_cancel_outcome(
        rc=rc,
        stdout=stdout,
        stderr=stderr,
        user_prompt=user_prompt,
        forced_escalation=forced_escalation,
    )
    if not result.ok:
        raise CancelOracleError(result.reason)
    return result


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    import sys

    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--rc", type=int, required=True)
    p.add_argument("--stdout-file", required=True)
    p.add_argument("--stderr-file", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--forced-escalation", action="store_true")
    args = p.parse_args(argv)
    from pathlib import Path

    out = Path(args.stdout_file).read_text(encoding="utf-8", errors="replace")
    err = Path(args.stderr_file).read_text(encoding="utf-8", errors="replace")
    try:
        r = require_cancel_outcome(
            rc=args.rc,
            stdout=out,
            stderr=err,
            user_prompt=args.prompt,
            forced_escalation=args.forced_escalation,
        )
    except CancelOracleError as e:
        print(f"cancel_oracle_fail: {e}", file=sys.stderr)
        return 2
    print(f"cancel_oracle_ok rc={r.rc} reason={r.reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
