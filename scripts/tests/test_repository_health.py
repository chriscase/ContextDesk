from __future__ import annotations

import importlib.util
import ntpath
import posixpath
import subprocess
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

    def test_ts_import_lexer_ignores_prose_and_includes_side_effect_imports(self) -> None:
        source = r'''
const prose = "import './synthetic'";
const moreProse = "from './also-synthetic'";
const template = `import './template-synthetic'`;
// import "./comment-synthetic";
/* export { fake } from "./block-comment-synthetic"; */
import "./setup";
import type { Api } from "./api";
export { helper } from "./helper";
const lazy = import("./lazy");
const legacy = require("./legacy");
object.import("./method-synthetic");
'''
        self.assertEqual(
            health.extract_ts_imports(source),
            ["./setup", "./api", "./helper", "./lazy", "./legacy"],
        )

    def test_git_path_graph_has_windows_emulation_fixture_parity(self) -> None:
        paths = {
            "desktop/src/App.tsx",
            "desktop/src/setup.ts",
            "desktop/src/lib/api.ts",
            "desktop/src/components/Card/index.tsx",
        }
        blobs = {
            "desktop/src/App.tsx": (
                b'import "./setup";\n'
                b'import { api } from "./lib/api";\n'
                b'import { Card } from "./components/Card";\n'
                b'import { absent } from "./missing";\n'
            ),
            "desktop/src/setup.ts": b"export {};\n",
            "desktop/src/lib/api.ts": b"export const api = true;\n",
            "desktop/src/components/Card/index.tsx": b"export const Card = () => null;\n",
        }
        facts = [
            health.FileFacts(
                path,
                health.language_for(path),
                "Desktop UI",
                len(blobs[path]),
                1,
                1,
                0,
                0,
                0,
                0,
            )
            for path in sorted(paths)
        ]
        graph = health.ts_import_graph(facts, blobs)
        self.assertEqual(graph["resolved_relative_import_edges"], 3)
        self.assertEqual(graph["unresolved_relative_imports"], 1)
        self.assertEqual(
            health.resolve_ts_import(
                "desktop/src/App.tsx", "./components/Card", paths
            ),
            "desktop/src/components/Card/index.tsx",
        )
        # This is the previous Windows-host failure mode: ntpath introduces
        # backslashes into a Git path. The production resolver always uses POSIX.
        self.assertIn(
            "\\", ntpath.normpath("desktop/src/./components/Card/index.tsx")
        )
        self.assertEqual(
            posixpath.normpath("desktop/src/./components/Card/index.tsx"),
            "desktop/src/components/Card/index.tsx",
        )

    def test_fingerprint_is_path_and_content_deterministic(self) -> None:
        blobs = {"a.txt": b"alpha", "b.txt": b"beta"}
        first = health.tree_fingerprint(blobs, ["a.txt", "b.txt"])
        second = health.tree_fingerprint(blobs, ["b.txt", "a.txt"])
        self.assertEqual(first, second)
        changed = {**blobs, "b.txt": b"changed"}
        self.assertNotEqual(
            first, health.tree_fingerprint(changed, ["a.txt", "b.txt"])
        )

    def test_index_blob_metrics_ignore_checkout_crlf_conversion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            root.joinpath(".gitattributes").write_text(
                "*.txt text eol=lf\n", encoding="utf-8"
            )
            sample = root / "sample.txt"
            sample.write_bytes(b"one\ntwo\n")
            subprocess.run(
                ["git", "add", ".gitattributes", "sample.txt"], cwd=root, check=True
            )
            before = health.collect(root)
            sample.write_bytes(b"one\r\ntwo\r\n")
            after = health.collect(root)
            self.assertEqual(before["scope"], after["scope"])
            self.assertEqual(before["exact"], after["exact"])
            entries = health.tracked_entries(root)
            self.assertEqual(
                health.tracked_blob_bytes(root, entries)["sample.txt"], b"one\ntwo\n"
            )

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
            blobs = {
                "crates/tracked/Cargo.toml": tracked.joinpath("Cargo.toml").read_bytes()
            }
            packages, edges = health.cargo_packages(
                ["crates/tracked/Cargo.toml"], blobs
            )
            self.assertEqual(
                packages,
                [{"name": "tracked", "manifest": "crates/tracked/Cargo.toml"}],
            )
            self.assertEqual(edges, [])

    def test_absolute_output_paths_write_and_check_outside_repository(self) -> None:
        with (
            tempfile.TemporaryDirectory() as repository,
            tempfile.TemporaryDirectory() as output,
        ):
            root = Path(repository)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            root.joinpath("README.md").write_text("# Fixture\n", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=root, check=True)
            json_path = Path(output) / "health.json"
            markdown_path = Path(output) / "health.md"
            arguments = [
                "--root",
                str(root),
                "--json",
                str(json_path),
                "--markdown",
                str(markdown_path),
            ]
            self.assertEqual(health.main(arguments), 0)
            self.assertTrue(json_path.is_file())
            self.assertTrue(markdown_path.is_file())
            self.assertEqual(health.main([*arguments, "--check"]), 0)


if __name__ == "__main__":
    unittest.main()
