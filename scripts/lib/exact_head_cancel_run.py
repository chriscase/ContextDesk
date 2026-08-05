#!/usr/bin/env python3
"""Launch contextdesk chat, wait for mock in-flight, SIGINT the CLI process group.

Writes:
  --stdout-file / --stderr-file  (CLI streams)
  --rc-file                       cancel_rc=N\\nforced_escalation=0|1
  --pid-file                      CLI pid

Exit code of *this* helper is 0 if the launch/signal/wait machinery worked;
the consolidator still runs exact_head_cancel_oracle on the artifacts.
"""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bin", required=True)
    p.add_argument("--app-config", required=True)
    p.add_argument("--data-dir", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--stdout-file", required=True)
    p.add_argument("--stderr-file", required=True)
    p.add_argument("--rc-file", required=True)
    p.add_argument("--pid-file", required=True)
    p.add_argument("--inflight-file", required=True)
    p.add_argument("--grace-secs", type=float, default=8.0)
    p.add_argument("--inflight-timeout-secs", type=float, default=25.0)
    args = p.parse_args(argv)

    out_path = Path(args.stdout_file)
    err_path = Path(args.stderr_file)
    inflight = Path(args.inflight_file)
    if inflight.exists():
        inflight.unlink()

    env = os.environ.copy()
    env["ACCEPT_CANCEL_INFLIGHT_PATH"] = str(inflight)
    env.setdefault("ACCEPT_CANCEL_SLEEP_SECS", "30")

    out_f = open(out_path, "wb")
    err_f = open(err_path, "wb")
    cmd = [
        args.bin,
        "--app-config",
        args.app_config,
        "--data-dir",
        args.data_dir,
        "--jsonl",
        "chat",
        args.prompt,
        "--new",
        "--auto-approve",
    ]
    # New session = new process group; SIGINT can target the group.
    proc = subprocess.Popen(
        cmd,
        stdout=out_f,
        stderr=err_f,
        start_new_session=True,
        env=env,
    )
    Path(args.pid_file).write_text(str(proc.pid) + "\n", encoding="utf-8")

    # Wait until mock confirms provider request is in flight.
    deadline = time.monotonic() + args.inflight_timeout_secs
    saw_inflight = False
    while time.monotonic() < deadline:
        if inflight.is_file():
            saw_inflight = True
            break
        if proc.poll() is not None:
            break
        time.sleep(0.05)

    if not saw_inflight:
        # Cleanup only — oracle will not accept.
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=2)
        out_f.close()
        err_f.close()
        Path(args.rc_file).write_text(
            f"cancel_rc={proc.returncode if proc.returncode is not None else -1}\n"
            f"forced_escalation=1\n"
            f"inflight=0\n",
            encoding="utf-8",
        )
        print("cancel_run: provider never went in-flight", file=sys.stderr)
        return 3

    # Cooperative SIGINT to the process group.
    try:
        os.killpg(proc.pid, signal.SIGINT)
    except ProcessLookupError:
        pass

    forced = 0
    try:
        proc.wait(timeout=args.grace_secs)
    except subprocess.TimeoutExpired:
        forced = 1
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=2)

    out_f.close()
    err_f.close()
    rc = proc.returncode if proc.returncode is not None else -1
    # Normalize negative signal codes from Python wait (e.g. -2 → 130).
    if rc is not None and rc < 0:
        rc = 128 + (-rc)
    Path(args.rc_file).write_text(
        f"cancel_rc={rc}\nforced_escalation={forced}\ninflight=1\n",
        encoding="utf-8",
    )
    print(f"cancel_run: rc={rc} forced_escalation={forced} inflight=1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
