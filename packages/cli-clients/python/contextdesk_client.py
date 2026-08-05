#!/usr/bin/env python3
"""Minimal Python thin client for the ContextDesk CLI subprocess protocol.

Spawns `contextdesk` with an argv list (shell mode disabled). See docs/CLI_CLIENT_PROTOCOL.md.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence


class ContextDeskError(RuntimeError):
    def __init__(self, kind: str, message: str, exit_code: int):
        super().__init__(f"{kind}: {message} (exit={exit_code})")
        self.kind = kind
        self.message = message
        self.exit_code = exit_code


def resolve_bin(explicit: Optional[str] = None) -> str:
    cand = explicit or os.environ.get("CONTEXTDESK_BIN") or "contextdesk"
    return cand


def run_json(
    args: Sequence[str],
    *,
    data_dir: Optional[Path] = None,
    bin_path: Optional[str] = None,
    env: Optional[Mapping[str, str]] = None,
    cwd: Optional[Path] = None,
    timeout: Optional[float] = None,
) -> Dict[str, Any]:
    """Run contextdesk with --json; return parsed envelope."""
    bin_ = resolve_bin(bin_path)
    argv: List[str] = [bin_]
    if data_dir is not None:
        argv.extend(["--data-dir", str(data_dir)])
    argv.append("--json")
    argv.extend(args)

    full_env = os.environ.copy()
    if env:
        full_env.update(env)

    # Argv list only — never enable shell mode.
    proc = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        env=full_env,
        cwd=str(cwd) if cwd else None,
        timeout=timeout,
        check=False,
        shell=False,
    )
    stdout = (proc.stdout or "").strip()
    if not stdout:
        raise ContextDeskError(
            "internal" if proc.returncode not in (0, 1, 3, 4, 5, 6, 7, 8, 70, 130) else "user_error",
            f"empty stdout (stderr={proc.stderr[:400]!r})",
            proc.returncode,
        )
    try:
        envelope = json.loads(stdout.splitlines()[-1])
    except json.JSONDecodeError as e:
        raise ContextDeskError("internal", f"invalid JSON: {e}: {stdout[:400]!r}", proc.returncode) from e

    if not envelope.get("ok", False):
        err = envelope.get("error") or {}
        raise ContextDeskError(
            err.get("kind") or "internal",
            err.get("message") or "command failed",
            proc.returncode,
        )
    if proc.returncode != 0:
        raise ContextDeskError("internal", f"ok envelope but exit {proc.returncode}", proc.returncode)
    return envelope


def capabilities(**kwargs: Any) -> Dict[str, Any]:
    return run_json(["capabilities"], **kwargs)


def main(argv: Sequence[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print("usage: contextdesk_client.py <capabilities|raw...> [--data-dir DIR]", file=sys.stderr)
        return 2
    data_dir = None
    args = list(argv[1:])
    if "--data-dir" in args:
        i = args.index("--data-dir")
        data_dir = Path(args[i + 1])
        del args[i : i + 2]
    if args[0] == "capabilities":
        env = capabilities(data_dir=data_dir)
        print(json.dumps(env, indent=2))
        return 0
    env = run_json(args, data_dir=data_dir)
    print(json.dumps(env, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except ContextDeskError as e:
        print(json.dumps({"ok": False, "error": {"kind": e.kind, "message": e.message}}), file=sys.stderr)
        raise SystemExit(e.exit_code or 70)
