from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "repository_health.py"
SPEC = importlib.util.spec_from_file_location("repository_health", SCRIPT)
assert SPEC and SPEC.loader
health = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = health
SPEC.loader.exec_module(health)


class RepositoryHealthTests(unittest.TestCase):
    def test_exclusions_are_explicit_and_reports_do_not_measure_themselves(self) -> None:
        self.assertEqual(health.exclusion_reason("Cargo.lock"), "dependency lockfile")
        self.assertEqual(
            health.exclusion_reason("crates/cd-core/tests/fixtures/input.json"),
            "fixture/snapshot asset",
        )
        self.assertEqual(
            health.exclusion_reason("docs/development/REPOSITORY_HEALTH.md"),
            "generated health report",
        )
        self.assertEqual(
            health.exclusion_reason("desktop/src-tauri/gen/schemas/capabilities.json"),
            "fixture/vendor/build tree",
        )
        self.assertIsNone(health.exclusion_reason("crates/cd-core/src/lib.rs"))

    def test_language_and_system_grouping(self) -> None:
        self.assertEqual(health.language_for("desktop/src/App.tsx"), "TypeScript/TSX")
        self.assertEqual(
            health.system_for("crates/cd-core/src/lib.rs"), "Rust crate: cd-core"
        )
        self.assertEqual(health.system_for("desktop/src/App.tsx"), "Desktop UI")
        self.assertEqual(
            health.system_for("packages/cli-clients/README.md"),
            "CLI client examples/config",
        )

    def test_physical_lines_handle_final_newline_without_phantom_line(self) -> None:
        self.assertEqual(health.physical_line_count(""), 0)
        self.assertEqual(health.physical_line_count("one\n"), 1)
        self.assertEqual(health.physical_line_count("one\ntwo"), 2)

    def test_lexical_counts_are_conservative_and_ignore_comment_lines(self) -> None:
        rust = """
// fn not_real() {}
#[test]
fn works() { if ready && valid { run(); } }
pub struct Packet { value: u8 }
"""
        self.assertEqual(health.lexical_facts(rust, "Rust"), (1, 1, 1, 2))
        ts = """
// function notReal() {}
export function render() { if (ready || valid) return 1 }
export const load = async (id: string) => id
interface State { ready: boolean }
test("renders", () => {})
"""
        self.assertEqual(health.lexical_facts(ts, "TypeScript"), (2, 1, 1, 2))

    def test_relative_import_resolution_supports_files_and_index_modules(self) -> None:
        candidates = {
            "desktop/src/App.tsx",
            "desktop/src/lib/api.ts",
            "desktop/src/components/Card/index.tsx",
        }
        self.assertEqual(
            health.resolve_ts_import("desktop/src/App.tsx", "./lib/api", candidates),
            "desktop/src/lib/api.ts",
        )
        self.assertEqual(
            health.resolve_ts_import(
                "desktop/src/App.tsx", "./components/Card", candidates
            ),
            "desktop/src/components/Card/index.tsx",
        )

    def test_fingerprint_is_path_and_content_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.txt").write_text("alpha", encoding="utf-8")
            (root / "b.txt").write_text("beta", encoding="utf-8")
            first = health.tree_fingerprint(root, ["a.txt", "b.txt"])
            second = health.tree_fingerprint(root, ["b.txt", "a.txt"])
            self.assertEqual(first, second)
            (root / "b.txt").write_text("changed", encoding="utf-8")
            self.assertNotEqual(first, health.tree_fingerprint(root, ["a.txt", "b.txt"]))

    def test_cargo_inventory_uses_only_supplied_tracked_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tracked = root / "crates" / "tracked"
            untracked = root / "vendor" / "surprise"
            tracked.mkdir(parents=True)
            untracked.mkdir(parents=True)
            tracked.joinpath("Cargo.toml").write_text(
                '[package]\nname = "tracked"\nversion = "0.1.0"\n',
                encoding="utf-8",
            )
            untracked.joinpath("Cargo.toml").write_text(
                '[package]\nname = "surprise"\nversion = "0.1.0"\n',
                encoding="utf-8",
            )
            packages, edges = health.cargo_packages(root, ["crates/tracked/Cargo.toml"])
            self.assertEqual(
                packages,
                [{"name": "tracked", "manifest": "crates/tracked/Cargo.toml"}],
            )
            self.assertEqual(edges, [])


if __name__ == "__main__":
    unittest.main()
