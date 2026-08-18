#!/usr/bin/env python3
"""Provider-free contract checks for the triage comparison demo package.

These checks stay on fixture/schema/runbook text plus optional existing CLIs.
They do not invent an offline bench-compare mode and they do not call a provider.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEMO = ROOT / "fixtures" / "triage-comparison-demo"
RUNBOOK = ROOT / "docs" / "benchmarks" / "TRIAGE_COMPARISON_DEMO.md"
SCRIPT = ROOT / "scripts" / "triage-comparison-demo.sh"

CASE_ID = "case-demo-checkout-timeout"
SNAPSHOT_ID = "snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb"
TASK_ID = "task-162aec8ca84e72ecfc9164d4168d18b6e41367e7c10e9c23aef086bf83bfd007"
BLOB_HEX = "959969b69cac6ba8280a8cb6836226d91a621122a16703109cb690d5e7a50f75"
BLOB_BYTES = 487

SECRETISH = (
    "api_key",
    "apikey",
    "authorization",
    "bearer ",
    "password=",
    "secret=",
    "-----begin",
)
URLISH = re.compile(r"https?://", re.IGNORECASE)
INVENTED_OFFLINE = (
    "bench-compare --offline",
    "contextdesk bench-compare --offline",
    "cd-cli bench-compare --offline",
)


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def existing_bin(env_name: str, filename: str) -> str | None:
    override = os.environ.get(env_name)
    if override and Path(override).is_file():
        return override
    candidate = ROOT / "target" / "debug" / filename
    if candidate.is_file():
        return str(candidate)
    return None


class TriageComparisonDemoContractTests(unittest.TestCase):
    def test_package_files_exist(self) -> None:
        for relative in (
            "case.json",
            "snapshot.json",
            "task.json",
            "identities.json",
            "blobs/checkout.log",
            "candidates/candidate-a.json",
            "candidates/candidate-b.json",
            "recorded/human-run.json",
            "recorded/other-product-run.json",
            "replay/replay-completed.json",
            "replay/replay-failed.json",
            "README.md",
        ):
            path = DEMO / relative
            self.assertTrue(path.is_file(), path)

        self.assertTrue(RUNBOOK.is_file(), RUNBOOK)
        self.assertTrue(SCRIPT.is_file(), SCRIPT)
        self.assertTrue(os.access(SCRIPT, os.X_OK), f"{SCRIPT} must be executable")

    def test_blob_digest_matches_snapshot_and_identities(self) -> None:
        blob = (DEMO / "blobs" / "checkout.log").read_bytes()
        digest = hashlib.sha256(blob).hexdigest()
        self.assertEqual(len(blob), BLOB_BYTES)
        self.assertEqual(digest, BLOB_HEX)

        snapshot = load_json(DEMO / "snapshot.json")
        assert isinstance(snapshot, dict)
        item = snapshot["items"][0]
        self.assertEqual(item["kind"], "log")
        self.assertEqual(item["content"]["digest"]["hex"], digest)
        self.assertEqual(item["content"]["byte_length"], len(blob))
        self.assertEqual(snapshot["snapshot_id"], SNAPSHOT_ID)
        self.assertEqual(snapshot["schema_id"], "contextdesk.triage_bench.evidence_snapshot.v1")

        identities = load_json(DEMO / "identities.json")
        assert isinstance(identities, dict)
        self.assertEqual(identities["snapshot_id"], SNAPSHOT_ID)
        self.assertEqual(identities["blob"]["hex"], digest)
        self.assertEqual(identities["blob"]["byte_length"], len(blob))
        self.assertNotIn("schema_id", identities)

    def test_import_documents_use_published_schemas(self) -> None:
        case = load_json(DEMO / "case.json")
        task = load_json(DEMO / "task.json")
        assert isinstance(case, dict)
        assert isinstance(task, dict)
        self.assertEqual(case["schema_id"], "contextdesk.triage_bench.case.v1")
        self.assertEqual(case["case_id"], CASE_ID)
        self.assertEqual(task["schema_id"], "contextdesk.triage_bench.evaluation_task.v1")
        self.assertEqual(task["task_id"], TASK_ID)
        self.assertEqual(task["snapshot_id"], SNAPSHOT_ID)
        self.assertEqual(task["visibility"]["include_summaries"], False)
        self.assertEqual(task["visibility"]["include_raw_bytes"], True)
        self.assertEqual(task["visibility"]["visible_item_ids"], ["ev-demo-checkout-log"])
        self.assertNotIn("time_constraint", task)

        for name in ("human-run.json", "other-product-run.json"):
            document = load_json(DEMO / "recorded" / name)
            assert isinstance(document, dict)
            self.assertEqual(document["schema_id"], "contextdesk.triage_bench.run_import.v1")
            self.assertEqual(document["task_id"], TASK_ID)
            self.assertEqual(document["timing"], {"status": "unknown"})
            self.assertEqual(document["cost"], {"status": "unknown"})
            self.assertEqual(document["fairness"], {"kind": "same_snapshot"})

        human = load_json(DEMO / "recorded" / "human-run.json")
        other = load_json(DEMO / "recorded" / "other-product-run.json")
        assert isinstance(human, dict)
        assert isinstance(other, dict)
        self.assertEqual(human["source_kind"], "human")
        self.assertEqual(other["source_kind"], "other_product")

    def test_candidates_match_live_bench_compare_contract(self) -> None:
        first = load_json(DEMO / "candidates" / "candidate-a.json")
        second = load_json(DEMO / "candidates" / "candidate-b.json")
        assert isinstance(first, dict)
        assert isinstance(second, dict)
        self.assertEqual(first["policy"]["kind"], "standard")
        self.assertEqual(second["policy"]["kind"], "standard")
        self.assertNotEqual(first["cancellation_id"], second["cancellation_id"])
        self.assertEqual(first["policy"]["model"]["profile_id"], "HOST_PROFILE_ID")
        self.assertEqual(first["policy"]["model"]["model_id"], "HOST_MODEL_ID")
        self.assertEqual(second["policy"]["model"]["profile_id"], "HOST_PROFILE_ID")
        self.assertEqual(second["policy"]["model"]["model_id"], "HOST_MODEL_ID")
        for candidate in (first, second):
            self.assertIn("strategy", candidate)
            self.assertRegex(candidate["strategy"]["created_at"], r"Z$")
            self.assertNotIn("api_key", candidate)
            self.assertNotIn("endpoint", candidate)
            self.assertNotIn("base_url", candidate)

    def test_replay_envelopes_use_public_sdk_schema(self) -> None:
        for name in ("replay-completed.json", "replay-failed.json"):
            replay = load_json(DEMO / "replay" / name)
            assert isinstance(replay, dict)
            self.assertEqual(replay["schema_id"], "contextdesk.triage.replay.v1")
            self.assertTrue(replay["events"])
            kinds = [event["event"]["kind"] for event in replay["events"]]
            self.assertIn("packet_ready", kinds)
            self.assertEqual(replay["events"][0]["schema_id"], "contextdesk.triage.run_event.v2")

        completed = load_json(DEMO / "replay" / "replay-completed.json")
        failed = load_json(DEMO / "replay" / "replay-failed.json")
        assert isinstance(completed, dict)
        assert isinstance(failed, dict)
        completed_kinds = [event["event"]["kind"] for event in completed["events"]]
        failed_kinds = [event["event"]["kind"] for event in failed["events"]]
        self.assertIn("completed", completed_kinds)
        self.assertIn("failed", failed_kinds)

    def test_package_has_no_secrets_endpoints_or_cost_claims(self) -> None:
        files = [path for path in DEMO.rglob("*") if path.is_file()]
        files.extend([RUNBOOK, SCRIPT])
        for path in files:
            text = path.read_text(encoding="utf-8", errors="replace")
            lowered = text.lower()
            for needle in SECRETISH:
                self.assertNotIn(needle, lowered, f"{path} contains {needle}")
            if path.suffix in {".json", ".log"}:
                self.assertIsNone(URLISH.search(text), f"{path} contains a network URL")
            if path.suffix == ".json":
                payload = load_json(path)
                blob = json.dumps(payload)
                self.assertNotIn('"status": "known"', blob)
                self.assertNotIn("usd", blob.lower())
                self.assertNotIn("token_usage", blob.lower())

    def test_runbook_and_script_keep_live_and_offline_distinct(self) -> None:
        runbook = RUNBOOK.read_text(encoding="utf-8")
        script = SCRIPT.read_text(encoding="utf-8")
        readme = (DEMO / "README.md").read_text(encoding="utf-8")
        for text in (runbook, script, readme):
            lowered = text.lower()
            for invented in INVENTED_OFFLINE:
                self.assertNotIn(invented, lowered)
            self.assertIn("bench-compare", text)
            self.assertIn("record-replay", text)
            self.assertIn("import-run", text)

        self.assertIn("Live same-snapshot comparison", runbook)
        self.assertIn("Offline recorded / replay fallback", runbook)
        self.assertIn("HOST_PROFILE_ID", runbook)
        self.assertNotIn("contextdesk bench-compare --offline", script)
        self.assertIn("print-live", script)
        self.assertIn("This is not an offline bench-compare implementation.", script)
        # The helper may print the live command but must not execute it.
        self.assertNotRegex(script, r"^[^#\n]*\$CONTEXTDESK.*bench-compare", re.MULTILINE)
        self.assertNotRegex(script, r"^[^#\n]*contextdesk.*bench-compare", re.MULTILINE)

    def test_optional_cli_import_replay_and_report(self) -> None:
        bench = existing_bin("CD_TRIAGE_BENCH", "cd-triage-bench")
        adapter = existing_bin("CD_TRIAGE_BENCH_ADAPTER", "cd-triage-bench-adapter")
        if bench is None or adapter is None:
            self.skipTest("cd-triage-bench binaries are not built in this tree")

        with tempfile.TemporaryDirectory(prefix="cd-triage-comparison-demo-") as tmp:
            env = os.environ.copy()
            env["CD_TRIAGE_BENCH"] = bench
            env["CD_TRIAGE_BENCH_ADAPTER"] = adapter
            result = subprocess.run(
                [str(SCRIPT), "self-check", "--library", tmp],
                cwd=ROOT,
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(
                result.returncode,
                0,
                f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
            )
            self.assertIn("self-check passed", result.stdout)

        bench_help = subprocess.run(
            [bench, "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        help_text = bench_help.stdout + bench_help.stderr
        self.assertIn("import-case", help_text)
        self.assertIn("import-snapshot", help_text)
        self.assertIn("import-task", help_text)
        self.assertIn("import-run", help_text)
        self.assertIn("report", help_text)

        adapter_help = subprocess.run(
            [adapter, "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        adapter_text = adapter_help.stdout + adapter_help.stderr
        self.assertIn("record-replay", adapter_text)


if __name__ == "__main__":
    unittest.main()
