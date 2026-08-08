#!/usr/bin/env python3
"""Generate deterministic, low-cost repository health metrics.

The script intentionally uses only the Python standard library and Git's tracked
file inventory.  It reports physical facts separately from lexical heuristics;
it is a trend/navigation aid, not a quality score.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tomllib
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable


SCHEMA_VERSION = 1
DEFAULT_JSON = "docs/development/repository-health.json"
DEFAULT_MARKDOWN = "docs/development/REPOSITORY_HEALTH.md"
GENERATED_OUTPUTS = {DEFAULT_JSON, DEFAULT_MARKDOWN}

LANGUAGES = {
    ".rs": "Rust",
    ".ts": "TypeScript",
    ".tsx": "TypeScript/TSX",
    ".js": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    ".py": "Python",
    ".c": "C",
    ".h": "C/C++ header",
    ".cpp": "C++",
    ".hpp": "C/C++ header",
    ".cs": "C#",
    ".go": "Go",
    ".java": "Java",
    ".sh": "Shell",
    ".ps1": "PowerShell",
    ".css": "CSS",
    ".html": "HTML",
    ".md": "Markdown",
    ".toml": "TOML",
    ".json": "JSON",
    ".yml": "YAML",
    ".yaml": "YAML",
    ".sql": "SQL",
    ".svg": "SVG",
}

CODE_LANGUAGES = {
    "Rust",
    "TypeScript",
    "TypeScript/TSX",
    "JavaScript",
    "Python",
    "C",
    "C/C++ header",
    "C++",
    "C#",
    "Go",
    "Java",
    "Shell",
    "PowerShell",
    "CSS",
    "HTML",
    "SQL",
}

EXCLUDED_PREFIXES = (
    "fixtures/",
    "target/",
    "node_modules/",
    "desktop/dist/",
    "desktop/src-tauri/target/",
    "desktop/src-tauri/gen/",
    "vendor/",
    "third_party/",
)
EXCLUDED_SEGMENTS = {"fixtures", "__snapshots__", "__screenshots__"}
EXCLUDED_NAMES = {
    "Cargo.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
}

RUST_FUNCTION = re.compile(
    r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+[A-Za-z_]\w*\s*(?:<[^;{]*>)?\s*\("
)
RUST_TYPE = re.compile(
    r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+[A-Za-z_]\w*"
)
RUST_TEST = re.compile(r"^\s*#\s*\[\s*(?:tokio::)?test(?:\s*\([^]]*\))?\s*\]")
TS_FUNCTION = re.compile(
    r"^\s*(?:(?:export\s+)?(?:default\s+)?)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*[<(]"
)
TS_ARROW = re.compile(
    r"^\s*(?:export\s+)?(?:const|let)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>"
)
TS_TYPE = re.compile(
    r"^\s*(?:export\s+)?(?:interface|type|class|enum)\s+[A-Za-z_$][\w$]*"
)
TS_TEST = re.compile(r"\b(?:it|test)\s*\(")
PY_FUNCTION = re.compile(r"^\s*(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(")
PY_TYPE = re.compile(r"^\s*class\s+[A-Za-z_]\w*\s*(?:\([^)]*\))?:")
PY_TEST = re.compile(r"^\s*(?:async\s+)?def\s+test_[A-Za-z_]\w*\s*\(")

TS_IMPORT = re.compile(
    r"(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['\"](\.[^'\"]+)['\"]"
)


@dataclass(frozen=True)
class FileFacts:
    path: str
    language: str
    system: str
    bytes: int
    physical_lines: int
    nonblank_lines: int
    functions: int
    types: int
    tests: int
    decision_tokens: int


def run_git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout


def tracked_files(root: Path) -> list[str]:
    raw = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, check=True, capture_output=True
    ).stdout
    return sorted(part.decode("utf-8") for part in raw.split(b"\0") if part)


def language_for(path: str) -> str:
    name = PurePosixPath(path).name
    if name == "Dockerfile" or name.startswith("Dockerfile."):
        return "Dockerfile"
    if name == "Makefile":
        return "Makefile"
    return LANGUAGES.get(PurePosixPath(path).suffix.lower(), "Other text")


def system_for(path: str) -> str:
    parts = PurePosixPath(path).parts
    if len(parts) >= 2 and parts[0] == "crates":
        return f"Rust crate: {parts[1]}"
    if len(parts) >= 4 and parts[:2] == ("packages", "cli-clients"):
        return f"CLI client example: {parts[2]}"
    if len(parts) >= 2 and parts[:2] == ("packages", "cli-clients"):
        return "CLI client examples/config"
    if len(parts) >= 2 and parts[0] == "packages":
        return f"SDK package: {parts[1]}"
    if path.startswith("desktop/src-tauri/"):
        return "Desktop host (Tauri)"
    if path.startswith("desktop/src/"):
        return "Desktop UI"
    if path.startswith("desktop/gui-accept/"):
        return "Desktop acceptance harness"
    if path.startswith("desktop/"):
        return "Desktop tooling/config"
    if path.startswith("scripts/"):
        return "Repository tooling"
    if path.startswith("docs/"):
        return "Documentation"
    if path.startswith("fixtures/"):
        return "Fixtures"
    if path.startswith(".github/"):
        return "GitHub automation"
    return "Repository root/config"


def architecture_area(path: str) -> str:
    """Return a stable, path-derived area used only for import-locality hints."""
    parts = PurePosixPath(path).parts
    if len(parts) >= 2 and parts[0] == "crates":
        return "/".join(parts[:2])
    if len(parts) >= 4 and parts[:2] == ("desktop", "src"):
        if parts[2] in {"components", "lib"}:
            return "/".join(parts[:4]) if len(parts) > 4 else "/".join(parts[:3])
        return "/".join(parts[:3])
    if path.startswith("desktop/src-tauri/"):
        return "desktop/src-tauri"
    return system_for(path)


def exclusion_reason(path: str) -> str | None:
    if path in GENERATED_OUTPUTS:
        return "generated health report"
    if PurePosixPath(path).name in EXCLUDED_NAMES:
        return "dependency lockfile"
    if path.startswith(EXCLUDED_PREFIXES):
        return "fixture/vendor/build tree"
    if EXCLUDED_SEGMENTS.intersection(PurePosixPath(path).parts):
        return "fixture/snapshot asset"
    suffix = PurePosixPath(path).suffix.lower()
    if suffix in {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".ico",
        ".woff",
        ".woff2",
        ".ttf",
        ".pdf",
        ".zip",
    }:
        return "binary/media asset"
    return None


def decode_text(data: bytes) -> str | None:
    if b"\0" in data[:8192]:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def physical_line_count(text: str) -> int:
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def strip_lexical_comments(line: str, language: str) -> str:
    """Remove obvious single-line comments for heuristic token counting only."""
    stripped = line.strip()
    if language in {"Rust", "TypeScript", "TypeScript/TSX", "JavaScript"}:
        if stripped.startswith("//"):
            return ""
        return line.split("//", 1)[0]
    if language in {"Python", "Shell", "PowerShell"}:
        if stripped.startswith("#"):
            return ""
        return line.split("#", 1)[0]
    return line


def lexical_facts(text: str, language: str) -> tuple[int, int, int, int]:
    """Return lexical function/type/test/decision counts (all heuristic)."""
    functions = types = tests = decisions = 0
    for line in text.splitlines():
        code = strip_lexical_comments(line, language)
        if not code.strip():
            continue
        if language == "Rust":
            functions += bool(RUST_FUNCTION.search(code))
            types += bool(RUST_TYPE.search(code))
            tests += bool(RUST_TEST.search(code))
            decisions += len(re.findall(r"\b(?:if|match|for|while|loop)\b", code))
            decisions += code.count("&&") + code.count("||")
        elif language in {"TypeScript", "TypeScript/TSX", "JavaScript"}:
            functions += bool(TS_FUNCTION.search(code) or TS_ARROW.search(code))
            types += bool(TS_TYPE.search(code))
            tests += len(TS_TEST.findall(code))
            decisions += len(re.findall(r"\b(?:if|switch|case|for|while|catch)\b", code))
            decisions += code.count("&&") + code.count("||")
        elif language == "Python":
            functions += bool(PY_FUNCTION.search(code))
            types += bool(PY_TYPE.search(code))
            tests += bool(PY_TEST.search(code))
            decisions += len(re.findall(r"\b(?:if|elif|for|while|except|and|or)\b", code))
    return functions, types, tests, decisions


def inspect_file(root: Path, path: str) -> tuple[FileFacts | None, str | None]:
    reason = exclusion_reason(path)
    if reason:
        return None, reason
    data = (root / path).read_bytes()
    text = decode_text(data)
    if text is None:
        return None, "non-UTF-8/binary file"
    language = language_for(path)
    functions, types, tests, decisions = lexical_facts(text, language)
    return (
        FileFacts(
            path=path,
            language=language,
            system=system_for(path),
            bytes=len(data),
            physical_lines=physical_line_count(text),
            nonblank_lines=sum(bool(line.strip()) for line in text.splitlines()),
            functions=functions,
            types=types,
            tests=tests,
            decision_tokens=decisions,
        ),
        None,
    )


def percentile(values: list[int], percent: int) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = (len(ordered) - 1) * percent // 100
    return ordered[index]


def summarize_group(files: Iterable[FileFacts], key: str) -> list[dict[str, object]]:
    grouped: dict[str, list[FileFacts]] = defaultdict(list)
    for fact in files:
        grouped[getattr(fact, key)].append(fact)
    rows = []
    for name, members in grouped.items():
        rows.append(
            {
                "name": name,
                "files": len(members),
                "bytes": sum(item.bytes for item in members),
                "physical_lines": sum(item.physical_lines for item in members),
                "nonblank_lines": sum(item.nonblank_lines for item in members),
                "functions_heuristic": sum(item.functions for item in members),
                "types_heuristic": sum(item.types for item in members),
                "tests_heuristic": sum(item.tests for item in members),
                "decision_tokens_heuristic": sum(item.decision_tokens for item in members),
            }
        )
    return sorted(rows, key=lambda row: (-int(row["physical_lines"]), str(row["name"])))


def cargo_packages(
    root: Path, tracked_paths: Iterable[str]
) -> tuple[list[dict[str, object]], list[dict[str, str]]]:
    manifests = [
        root / path
        for path in sorted(tracked_paths)
        if PurePosixPath(path).name == "Cargo.toml" and exclusion_reason(path) is None
    ]
    packages: list[dict[str, object]] = []
    package_by_dir: dict[Path, str] = {}
    manifest_data: dict[Path, dict[str, object]] = {}
    for manifest in manifests:
        data = tomllib.loads(manifest.read_text(encoding="utf-8"))
        package = data.get("package")
        if not isinstance(package, dict) or not isinstance(package.get("name"), str):
            continue
        name = str(package["name"])
        rel = manifest.relative_to(root).as_posix()
        package_by_dir[manifest.parent.resolve()] = name
        manifest_data[manifest] = data
        packages.append({"name": name, "manifest": rel})

    edges: set[tuple[str, str, str]] = set()
    for manifest, data in manifest_data.items():
        source = package_by_dir[manifest.parent.resolve()]
        for section in ("dependencies", "dev-dependencies", "build-dependencies"):
            dependencies = data.get(section, {})
            if not isinstance(dependencies, dict):
                continue
            for declared_name, value in dependencies.items():
                if not isinstance(value, dict) or not isinstance(value.get("path"), str):
                    continue
                target_dir = (manifest.parent / str(value["path"])).resolve()
                target = package_by_dir.get(target_dir)
                if target:
                    edges.add((source, target, section))
    return sorted(packages, key=lambda row: str(row["name"])), [
        {"from": source, "to": target, "kind": kind}
        for source, target, kind in sorted(edges)
    ]


def resolve_ts_import(source: str, specifier: str, candidates: set[str]) -> str | None:
    base = PurePosixPath(source).parent.joinpath(specifier)
    normalized = PurePosixPath(os.path.normpath(base.as_posix())).as_posix()
    probes = [
        normalized,
        *(normalized + suffix for suffix in (".ts", ".tsx", ".js", ".mjs")),
        *(f"{normalized}/index{suffix}" for suffix in (".ts", ".tsx", ".js", ".mjs")),
    ]
    return next((probe for probe in probes if probe in candidates), None)


def ts_import_graph(root: Path, facts: list[FileFacts]) -> dict[str, object]:
    candidates = {
        fact.path
        for fact in facts
        if fact.language in {"TypeScript", "TypeScript/TSX", "JavaScript"}
    }
    edges: set[tuple[str, str]] = set()
    unresolved = 0
    for source in sorted(candidates):
        text = (root / source).read_text(encoding="utf-8")
        for specifier in TS_IMPORT.findall(text):
            target = resolve_ts_import(source, specifier, candidates)
            if target:
                edges.add((source, target))
            else:
                unresolved += 1
    fan_in = Counter(target for _, target in edges)
    fan_out = Counter(source for source, _ in edges)
    local_edges = sum(architecture_area(a) == architecture_area(b) for a, b in edges)
    total = len(edges)
    return {
        "resolved_relative_import_edges": total,
        "unresolved_relative_imports": unresolved,
        "same_area_edges": local_edges,
        "same_area_ratio": round(local_edges / total, 4) if total else None,
        "highest_fan_in": [
            {"path": path, "edges": count}
            for path, count in sorted(fan_in.items(), key=lambda item: (-item[1], item[0]))[:10]
        ],
        "highest_fan_out": [
            {"path": path, "edges": count}
            for path, count in sorted(fan_out.items(), key=lambda item: (-item[1], item[0]))[:10]
        ],
    }


def tree_fingerprint(root: Path, paths: Iterable[str]) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths):
        data = (root / path).read_bytes()
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def collect(root: Path) -> dict[str, object]:
    paths = tracked_files(root)
    facts: list[FileFacts] = []
    excluded = Counter()
    for path in paths:
        fact, reason = inspect_file(root, path)
        if fact:
            facts.append(fact)
        else:
            excluded[reason or "unknown"] += 1

    code_files = [fact for fact in facts if fact.language in CODE_LANGUAGES]
    sizes = [fact.nonblank_lines for fact in code_files]
    packages, cargo_edges = cargo_packages(root, paths)
    large_files = sorted(code_files, key=lambda fact: (-fact.nonblank_lines, fact.path))[:20]
    code_nonblank = sum(fact.nonblank_lines for fact in code_files)
    decisions = sum(fact.decision_tokens for fact in code_files)
    fingerprint_paths = [path for path in paths if path not in GENERATED_OUTPUTS]

    return {
        "schema_version": SCHEMA_VERSION,
        "scope": {
            "inventory": "git tracked files",
            "tracked_content_fingerprint_sha256": tree_fingerprint(root, fingerprint_paths),
            "tracked_files": len(paths),
            "analyzed_text_files": len(facts),
            "excluded_files": sum(excluded.values()),
            "excluded_by_reason": dict(sorted(excluded.items())),
        },
        "exact": {
            "analyzed_bytes": sum(fact.bytes for fact in facts),
            "physical_lines": sum(fact.physical_lines for fact in facts),
            "nonblank_lines": sum(fact.nonblank_lines for fact in facts),
            "maintained_code_files": len(code_files),
            "maintained_code_physical_lines": sum(fact.physical_lines for fact in code_files),
            "maintained_code_nonblank_lines": code_nonblank,
            "code_file_nonblank_line_distribution": {
                "median_p50": percentile(sizes, 50),
                "p90": percentile(sizes, 90),
                "p95": percentile(sizes, 95),
                "maximum": max(sizes, default=0),
                "at_least_500": sum(value >= 500 for value in sizes),
                "at_least_1000": sum(value >= 1000 for value in sizes),
            },
        },
        "heuristic": {
            "functions": sum(fact.functions for fact in code_files),
            "types": sum(fact.types for fact in code_files),
            "tests": sum(fact.tests for fact in code_files),
            "decision_tokens": decisions,
            "decision_tokens_per_1000_nonblank_code_lines": round(
                decisions * 1000 / code_nonblank, 2
            )
            if code_nonblank
            else 0,
        },
        "languages": summarize_group(facts, "language"),
        "systems": summarize_group(facts, "system"),
        "hotspots": [asdict(fact) for fact in large_files],
        "dependencies": {
            "cargo_packages": packages,
            "cargo_internal_edges": cargo_edges,
            "typescript_relative_imports": ts_import_graph(root, facts),
        },
        "methodology": {
            "exact": [
                "tracked-file inventory, bytes, physical/nonblank lines, and file-size distribution",
                "path-derived language/system grouping",
                "Cargo path dependency declarations between workspace packages",
            ],
            "heuristic": [
                "functions, types, and tests are conservative Rust/TypeScript/JavaScript/Python line-oriented lexical matches",
                "decision tokens count control-flow/boolean tokens; they are not cyclomatic complexity",
                "TypeScript relative-import edges use static syntax and filesystem resolution",
                "same-area import ratio uses path-derived feature areas as a cohesion/coupling proxy",
            ],
        },
    }


def number(value: object) -> str:
    return f"{int(value):,}"


def markdown_table(headers: list[str], rows: list[list[object]]) -> str:
    result = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    result.extend("| " + " | ".join(str(cell) for cell in row) + " |" for row in rows)
    return "\n".join(result)


def render_markdown(data: dict[str, object]) -> str:
    exact = data["exact"]
    heuristic = data["heuristic"]
    scope = data["scope"]
    dependencies = data["dependencies"]
    ts_graph = dependencies["typescript_relative_imports"]
    dist = exact["code_file_nonblank_line_distribution"]
    language_rows = [
        [
            row["name"],
            number(row["files"]),
            number(row["physical_lines"]),
            number(row["nonblank_lines"]),
        ]
        for row in data["languages"]
    ]
    system_rows = [
        [
            row["name"],
            number(row["files"]),
            number(row["physical_lines"]),
            number(row["nonblank_lines"]),
            number(row["functions_heuristic"]),
            number(row["types_heuristic"]),
            number(row["tests_heuristic"]),
        ]
        for row in data["systems"]
    ]
    hotspot_rows = [
        [row["path"], number(row["nonblank_lines"]), row["language"], row["system"]]
        for row in data["hotspots"][:15]
    ]
    cargo_rows = [
        [edge["from"], edge["to"], edge["kind"]]
        for edge in dependencies["cargo_internal_edges"]
    ] or [["—", "—", "No internal path dependencies detected"]]
    fan_in_rows = [
        [row["path"], row["edges"]] for row in ts_graph["highest_fan_in"]
    ] or [["—", 0]]
    ratio = ts_graph["same_area_ratio"]
    ratio_text = "n/a" if ratio is None else f"{float(ratio) * 100:.1f}%"

    return f"""# Repository health snapshot

This checked-in snapshot describes the repository's **magnitude and structural
signals**, not developer productivity or product quality. Refresh it periodically
with `python3 scripts/repository_health.py`; it is intentionally not a required
per-commit CI gate.

Tracked-content fingerprint: `{scope['tracked_content_fingerprint_sha256']}`

## Headline measurements

| Signal | Value | Kind |
| --- | ---: | --- |
| Tracked files | {number(scope['tracked_files'])} | Exact |
| Analyzed maintained text files | {number(scope['analyzed_text_files'])} | Exact |
| Maintained code files | {number(exact['maintained_code_files'])} | Exact |
| Maintained code physical lines | {number(exact['maintained_code_physical_lines'])} | Exact |
| Maintained code nonblank lines | {number(exact['maintained_code_nonblank_lines'])} | Exact |
| Function declarations | {number(heuristic['functions'])} | Lexical heuristic |
| Type declarations | {number(heuristic['types'])} | Lexical heuristic |
| Test declarations | {number(heuristic['tests'])} | Lexical heuristic |
| Decision tokens / 1,000 nonblank code lines | {heuristic['decision_tokens_per_1000_nonblank_code_lines']} | Complexity proxy |

“Maintained code” excludes dependency lockfiles, fixture/snapshot trees,
generated health outputs, build/vendor trees, and binary/media assets. Tests are
included when they are maintained source files.

## Languages

{markdown_table(['Language', 'Files', 'Physical lines', 'Nonblank lines'], language_rows)}

## Systems, crates, and packages

{markdown_table(['System', 'Files', 'Physical lines', 'Nonblank lines', 'Functions*', 'Types*', 'Tests*'], system_rows)}

`*` Lexical heuristic; use these columns for orientation and trends, not exact inventory.

Cargo packages discovered: {number(len(dependencies['cargo_packages']))}.

{markdown_table(['From package', 'To package', 'Declaration kind'], cargo_rows)}

## File-size distribution and hotspots

The median maintained code file is {number(dist['median_p50'])} nonblank lines;
P90 is {number(dist['p90'])}, P95 is {number(dist['p95'])}, and the maximum is
{number(dist['maximum'])}. There are {number(dist['at_least_500'])} files at or
above 500 nonblank lines and {number(dist['at_least_1000'])} at or above 1,000.
These thresholds are navigation/refactoring prompts, not failures.

{markdown_table(['Path', 'Nonblank lines', 'Language', 'System'], hotspot_rows)}

## Dependency and design-health signals

- TypeScript/JavaScript resolved relative-import edges: **{number(ts_graph['resolved_relative_import_edges'])}**.
- Relative imports the lightweight resolver could not resolve: **{number(ts_graph['unresolved_relative_imports'])}**.
- Same path-derived architecture-area edges: **{ratio_text}** ({number(ts_graph['same_area_edges'])} edges).
- Decision tokens: **{number(heuristic['decision_tokens'])}**. This is a lexical
  control-flow density signal, not cyclomatic complexity and not a quality grade.

High fan-in files can be intentional shared boundaries or coupling hotspots:

{markdown_table(['Imported path', 'Incoming edges'], fan_in_rows)}

The same-area ratio is a coarse cohesion/coupling proxy: higher locality can
indicate cohesive feature areas, while cross-area edges can indicate healthy
layering or unwanted coupling. Interpret the underlying paths; do not optimize
the ratio itself.

## Measurement contract

### Exact in this snapshot

- Git tracked-file inventory, byte counts, physical lines, nonblank lines, file
  distributions, and path-derived group membership.
- Cargo package manifests and explicit internal `path` dependency declarations.
- Exclusions by documented path/name/media rules.

### Heuristic—use for trends and navigation

- Function, type, and test counts are conservative line-oriented lexical matches
  for Rust, TypeScript/JavaScript, and Python. Other languages contribute exact
  line totals but not declaration counts. Multiline or macro-generated
  declarations may be missed; callbacks may be counted differently.
- “Decision tokens” count common control-flow and boolean tokens after basic
  single-line comment removal. They do not understand syntax trees.
- Relative-import fan-in/fan-out scans static TypeScript/JavaScript syntax only.
  Aliases, dynamic imports, and generated modules may be absent.
- Architecture areas come from stable repository paths, not semantic analysis.

This report deliberately avoids a composite score, developer rankings, churn
judgments, or claims that line count measures value. Review trends alongside
architecture, tests, defects, and product outcomes.

## Refresh and validation

```bash
python3 scripts/repository_health.py
python3 scripts/repository_health.py --check
python3 -m unittest scripts.tests.test_repository_health
```

The companion JSON file is
[`repository-health.json`](repository-health.json). Both outputs are deterministic
for the same tracked tree because generated outputs exclude themselves from the
content fingerprint and measurements.
"""


def write_or_check(path: Path, content: str, check: bool) -> bool:
    if check:
        return path.exists() and path.read_text(encoding="utf-8") == content
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=None, help="repository root")
    parser.add_argument("--json", type=Path, default=Path(DEFAULT_JSON))
    parser.add_argument("--markdown", type=Path, default=Path(DEFAULT_MARKDOWN))
    parser.add_argument(
        "--check", action="store_true", help="fail if checked-in outputs are stale"
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    root = (args.root or Path(run_git(Path.cwd(), "rev-parse", "--show-toplevel").strip())).resolve()
    data = collect(root)
    json_content = json.dumps(data, indent=2, sort_keys=True) + "\n"
    markdown_content = render_markdown(data)
    json_path = args.json if args.json.is_absolute() else root / args.json
    markdown_path = args.markdown if args.markdown.is_absolute() else root / args.markdown
    json_ok = write_or_check(json_path, json_content, args.check)
    markdown_ok = write_or_check(markdown_path, markdown_content, args.check)
    if args.check and not (json_ok and markdown_ok):
        stale = []
        if not json_ok:
            stale.append(str(json_path.relative_to(root)))
        if not markdown_ok:
            stale.append(str(markdown_path.relative_to(root)))
        print("repository health snapshot is stale: " + ", ".join(stale), file=sys.stderr)
        return 1
    verb = "verified" if args.check else "wrote"
    print(f"{verb} {json_path.relative_to(root)} and {markdown_path.relative_to(root)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
