"""Provider-free contract checks for the Windows demo harness.

The script itself is exercised on Windows acceptance machines. These checks keep
the important architectural promises visible in the normal low-cost test path:
it delegates to the shipped CLI, runs serially, and keeps raw material out of
the aggregate report.
"""

from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "demo-corpus-batch.ps1"


class DemoCorpusBatchContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = SCRIPT.read_text(encoding="utf-8")

    def test_harness_uses_production_cli_surfaces(self) -> None:
        for needle in ("normalize", "import", "corpus", "chat", "--trace", "--activity"):
            self.assertIn(needle, self.source)
        self.assertIn("contextdesk.demo_corpus_batch.v1", self.source)

    def test_harness_is_serial_and_has_no_second_transport(self) -> None:
        self.assertIn("foreach ($item in $pendingCorpusCases)", self.source)
        self.assertNotIn("ForEach-Object -Parallel", self.source)
        self.assertNotIn("Invoke-RestMethod", self.source)
        self.assertNotIn("Invoke-WebRequest", self.source)
        self.assertNotIn("Start-Job", self.source)

    def test_raw_material_is_separated_from_aggregate_report(self) -> None:
        self.assertIn("raw-local-only", self.source)
        self.assertIn("normalized-preflight", self.source)
        self.assertIn("report.json", self.source)
        self.assertIn("report.md", self.source)
        self.assertIn("answer_markdown", self.source)
        self.assertIn("Raw JSONL/stdout and stderr remain local", self.source)
        self.assertIn("local_only = $true", self.source)

    def test_harness_fails_closed_on_malformed_or_incomplete_runs(self) -> None:
        for needle in (
            "function Test-PathWithin",
            "function Test-PathSameOrWithin",
            "function Test-ReparsePointInExistingPath",
            "function Get-CanonicalPath",
            "function Get-StrictBool",
            "Malformed = $malformed",
            "--fail-on-partial",
            "error_events",
            "validation_tier",
            "$liveTrace = $dryRun -eq $false",
            "all_required_passed",
            "if (-not $report.all_required_passed) { exit 1 }",
        ):
            self.assertIn(needle, self.source)
        self.assertNotIn("$args.Add('--auto-approve')", self.source)

    def test_harness_checks_existing_timezone_before_live_turn(self) -> None:
        self.assertIn("timezone", self.source)
        self.assertIn("unresolved_local_records", self.source)
        self.assertIn("status = if ($tzOk) { 'existing' } else { 'needs-timezone' }", self.source)
        self.assertIn("if ($tzOk) {", self.source)

    def test_default_output_is_disposable_and_contained_paths_are_rejected(self) -> None:
        self.assertIn("[System.IO.Path]::GetTempPath()", self.source)
        self.assertIn("OutputRoot and DataDir must be separate trees.", self.source)
        self.assertIn("DataDir and its existing parents must not contain a symlink", self.source)
        self.assertIn("OutputRoot and its existing parents must not contain a symlink", self.source)
        self.assertIn("Source inputs must not be symlinks", self.source)
        self.assertIn("Source inputs and their existing parents must not contain a symlink", self.source)
        self.assertIn("OutputRoot must be outside the ContextDesk checkout", self.source)
        self.assertIn("OutputRoot must be outside every source tree in both directions.", self.source)

    def test_powershell_parser_when_available(self) -> None:
        pwsh = shutil.which("pwsh")
        if pwsh is None:
            self.skipTest("PowerShell is not installed on this development host")
        command = (
            "$tokens=$null; $errors=$null; "
            "[System.Management.Automation.Language.Parser]::ParseFile(" 
            f"'{SCRIPT.as_posix()}', [ref]$tokens, [ref]$errors) | Out-Null; "
            "if ($errors.Count -ne 0) { $errors | % Message; exit 1 }"
        )
        subprocess.run([pwsh, "-NoProfile", "-NonInteractive", "-Command", command], check=True)

    def test_powershell_preflight_executes_when_available(self) -> None:
        pwsh = shutil.which("pwsh")
        if pwsh is None:
            self.skipTest("PowerShell is not installed on this development host")
        with tempfile.TemporaryDirectory(dir=ROOT.parent) as tmp:
            root = Path(tmp)
            data_dir = root / "data"
            data_dir.mkdir()
            source_dir = root / "source"
            source_dir.mkdir()
            source = source_dir / "input.log"
            source.write_text("fixture\n", encoding="utf-8")
            cli = root / "fake-contextdesk.ps1"
            cli.write_text(
                "param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Rest)\n"
                "Write-Output '{\"schema_version\":1,\"ok\":true,"
                "\"command\":\"normalize\",\"data\":{\"events\":1,"
                "\"sources_selected\":1,\"sources_failed\":0,\"partial\":false}}'\n",
                encoding="utf-8",
            )
            output = root / "output"
            completed = subprocess.run(
                [
                    pwsh,
                    "-NoProfile",
                    "-NonInteractive",
                    "-File",
                    str(SCRIPT),
                    "-Cli",
                    str(cli),
                    "-DataDir",
                    str(data_dir),
                    "-Source",
                    str(source),
                    "-OutputRoot",
                    str(output),
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
            report = json.loads((output / "report.json").read_text(encoding="utf-8-sig"))
            self.assertTrue(report["all_required_passed"])


if __name__ == "__main__":
    unittest.main()
