"""Provider-free contract checks for the Windows demo harness.

The script itself is exercised on Windows acceptance machines. These checks keep
the important architectural promises visible in the normal low-cost test path:
it delegates to the shipped CLI, runs serially, and keeps raw material out of
the aggregate report.
"""

from pathlib import Path
import shutil
import subprocess
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
        self.assertIn("report.json", self.source)
        self.assertIn("report.md", self.source)
        self.assertIn("answer_markdown", self.source)
        self.assertIn("Raw JSONL/stdout and stderr remain local", self.source)

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


if __name__ == "__main__":
    unittest.main()
