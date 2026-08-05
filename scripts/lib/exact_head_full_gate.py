#!/usr/bin/env python3
"""Pure gate logic for exact-head full acceptance (fail-closed).

`FULL_GATE_PASS` is only allowed when every required step has a successful
result. A missing step or non-zero exit cannot yield FULL_GATE_PASS.
`REHEARSAL_PASS` alone (consolidator-only) is narrower and never upgrades
to FULL_GATE_PASS without the rest of the gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional, Sequence


# Ordered required steps. IDs are stable for reports and mutation tests.
REQUIRED_STEPS: tuple[tuple[str, str], ...] = (
    ("identity_unit", "python3 scripts/tests/exact_head_identity_test.py"),
    ("cancel_oracle_unit", "python3 scripts/tests/exact_head_cancel_oracle_test.py"),
    (
        "timezone_utc_lab",
        "cargo test -p cd-cli --test exact_head_timezone_utc_lab",
    ),
    (
        "chat_cancellation",
        "cargo test -p cd-cli --test chat_cancellation",
    ),
    (
        "cli_activity_parity",
        "cargo test -p cd-cli --test cli_activity_parity",
    ),
    (
        "cli_public_acceptance_full_path",
        "cargo test -p cd-cli --test cli_public_acceptance_lab full_path",
    ),
    (
        "exact_head_cli_acceptance",
        "scripts/exact_head_cli_acceptance.sh",
    ),
)


@dataclass(frozen=True)
class StepResult:
    step_id: str
    exit_code: int
    present: bool = True  # False = required step never ran / missing from report


@dataclass(frozen=True)
class GateVerdict:
    full_gate_pass: bool
    reason: str
    first_failure: Optional[str] = None


def required_step_ids() -> tuple[str, ...]:
    return tuple(sid for sid, _ in REQUIRED_STEPS)


def evaluate_full_gate(results: Sequence[StepResult]) -> GateVerdict:
    """Fail closed: every REQUIRED step must be present and exit 0.

    A report that only contains REHEARSAL_PASS (consolidator) is insufficient.
    """
    by_id = {r.step_id: r for r in results if r.present}
    for step_id, _cmd in REQUIRED_STEPS:
        if step_id not in by_id:
            return GateVerdict(
                False,
                f"FULL_GATE_BLOCK: required step missing: {step_id}",
                first_failure=step_id,
            )
        r = by_id[step_id]
        if r.exit_code != 0:
            return GateVerdict(
                False,
                f"FULL_GATE_BLOCK: required step failed: {step_id} exit={r.exit_code}",
                first_failure=step_id,
            )
    # Reject spoof: unknown-only or empty success claims.
    if not results:
        return GateVerdict(False, "FULL_GATE_BLOCK: empty results", first_failure="(empty)")
    return GateVerdict(True, "FULL_GATE_PASS: all required steps exited 0", first_failure=None)


def rehearsal_pass_alone_is_not_full_gate(results: Iterable[StepResult]) -> bool:
    """True when results look like consolidator-only success (not full gate)."""
    ids = {r.step_id for r in results if r.present and r.exit_code == 0}
    return ids == {"exact_head_cli_acceptance"} or (
        "exact_head_cli_acceptance" in ids and not required_step_ids() <= ids
    )


def main(argv: Optional[list[str]] = None) -> int:
    import argparse
    import json
    import sys

    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--results-json",
        help="JSON list of {step_id, exit_code, present?} from a gate run",
    )
    p.add_argument("--print-steps", action="store_true")
    args = p.parse_args(argv)
    if args.print_steps:
        for sid, cmd in REQUIRED_STEPS:
            print(f"{sid}\t{cmd}")
        return 0
    if not args.results_json:
        print("need --results-json or --print-steps", file=sys.stderr)
        return 2
    raw = json.loads(args.results_json)
    results = [
        StepResult(
            step_id=row["step_id"],
            exit_code=int(row.get("exit_code", 1)),
            present=bool(row.get("present", True)),
        )
        for row in raw
    ]
    v = evaluate_full_gate(results)
    print(v.reason)
    return 0 if v.full_gate_pass else 2


if __name__ == "__main__":
    raise SystemExit(main())
