# Repository health snapshot

This checked-in snapshot describes the repository's **magnitude and structural
signals**, not developer productivity or product quality. Refresh it periodically
with `python3 scripts/repository_health.py`; it is intentionally not a required
per-commit CI gate.

Tracked-content fingerprint: `6346a1bbdf29dea1b43db9b528cbb3d697ece536996f0586cc7abc8e7bf89d27`

## Headline measurements

| Signal | Value | Kind |
| --- | ---: | --- |
| Tracked files | 1,428 | Exact |
| Analyzed maintained text files | 995 | Exact |
| Maintained code files | 786 | Exact |
| Maintained code physical lines | 431,916 | Exact |
| Maintained code nonblank lines | 405,932 | Exact |
| Function declarations | 9,536 | Lexical heuristic |
| Type declarations | 2,430 | Lexical heuristic |
| Test declarations | 4,478 | Lexical heuristic |
| Decision tokens / 1,000 nonblank code lines | 62.3 | Complexity proxy |

“Maintained code” excludes dependency lockfiles, fixture/snapshot trees,
generated health outputs, build/vendor trees, and binary/media assets. Tests are
included when they are maintained source files.

## Languages

| Language | Files | Physical lines | Nonblank lines |
| --- | --- | --- | --- |
| Rust | 251 | 259,103 | 244,823 |
| TypeScript/TSX | 192 | 95,184 | 90,297 |
| TypeScript | 214 | 39,987 | 37,178 |
| Markdown | 117 | 20,762 | 16,609 |
| CSS | 35 | 17,921 | 15,564 |
| JavaScript | 48 | 9,533 | 8,893 |
| Python | 19 | 5,794 | 5,143 |
| Shell | 18 | 3,266 | 2,990 |
| JSON | 22 | 1,721 | 1,721 |
| Other text | 33 | 812 | 727 |
| YAML | 7 | 807 | 749 |
| SVG | 19 | 787 | 748 |
| TOML | 11 | 399 | 358 |
| Java | 2 | 312 | 290 |
| C | 1 | 151 | 143 |
| C/C++ header | 1 | 147 | 133 |
| C# | 1 | 132 | 123 |
| C++ | 1 | 127 | 115 |
| PowerShell | 1 | 127 | 116 |
| Go | 1 | 116 | 108 |
| HTML | 1 | 16 | 16 |

## Systems, crates, and packages

| System | Files | Physical lines | Nonblank lines | Functions* | Types* | Tests* |
| --- | --- | --- | --- | --- | --- | --- |
| Rust crate: cd-core | 177 | 201,379 | 190,487 | 5,723 | 990 | 2,080 |
| Desktop UI | 402 | 142,258 | 132,819 | 1,648 | 912 | 1,545 |
| Desktop host (Tauri) | 16 | 24,334 | 22,957 | 794 | 152 | 195 |
| Documentation | 152 | 21,999 | 18,096 | 0 | 0 | 0 |
| Rust crate: cd-cli | 46 | 20,998 | 19,753 | 557 | 117 | 189 |
| Repository tooling | 42 | 11,474 | 10,422 | 210 | 13 | 130 |
| Desktop tooling/config | 34 | 7,672 | 7,204 | 77 | 9 | 72 |
| Rust crate: cd-server | 5 | 6,877 | 6,455 | 200 | 62 | 50 |
| Rust crate: cd-workflow | 15 | 5,703 | 5,349 | 149 | 26 | 66 |
| Desktop acceptance harness | 32 | 4,921 | 4,571 | 100 | 0 | 118 |
| Repository root/config | 27 | 3,433 | 2,993 | 40 | 1 | 6 |
| SDK package: contracts | 11 | 2,743 | 2,561 | 16 | 97 | 15 |
| SDK package: client | 9 | 1,259 | 1,203 | 10 | 48 | 10 |
| GitHub automation | 8 | 848 | 780 | 0 | 0 | 0 |
| CLI client example: java | 1 | 199 | 182 | 0 | 0 | 0 |
| CLI client example: c | 1 | 151 | 143 | 0 | 0 | 0 |
| CLI client example: shared | 1 | 147 | 133 | 0 | 0 | 0 |
| CLI client example: csharp | 1 | 132 | 123 | 0 | 0 | 0 |
| CLI client example: python | 1 | 129 | 107 | 5 | 2 | 0 |
| CLI client example: cpp | 1 | 127 | 115 | 0 | 0 | 0 |
| CLI client example: go | 1 | 116 | 108 | 0 | 0 | 0 |
| CLI client example: rust | 2 | 114 | 104 | 4 | 1 | 0 |
| CLI client example: node | 1 | 99 | 93 | 3 | 0 | 0 |
| SDK package: react | 4 | 36 | 35 | 0 | 0 | 1 |
| SDK package: ui | 4 | 36 | 35 | 0 | 0 | 1 |
| CLI client examples/config | 1 | 20 | 16 | 0 | 0 | 0 |

`*` Lexical heuristic; use these columns for orientation and trends, not exact inventory.

Cargo packages discovered: 6.

| From package | To package | Declaration kind |
| --- | --- | --- |
| cd-cli | cd-core | dependencies |
| cd-cli | cd-workflow | dependencies |
| cd-server | cd-core | dependencies |
| cd-workflow | cd-core | dependencies |
| contextdesk | cd-core | dependencies |
| contextdesk | cd-workflow | dependencies |

## File-size distribution and hotspots

The median maintained code file is 208 nonblank lines;
P90 is 1,074, P95 is 1,713, and the maximum is
18,039. There are 193 files at or
above 500 nonblank lines and 89 at or above 1,000.
These thresholds are navigation/refactoring prompts, not failures.

| Path | Nonblank lines | Language | System |
| --- | --- | --- | --- |
| desktop/src-tauri/src/lib.rs | 18,039 | Rust | Desktop host (Tauri) |
| crates/cd-core/src/tool_host.rs | 12,118 | Rust | Rust crate: cd-core |
| crates/cd-core/src/agent.rs | 11,504 | Rust | Rust crate: cd-core |
| desktop/src/components/logExplorer/LogExplorer.test.tsx | 9,532 | TypeScript/TSX | Desktop UI |
| desktop/src/components/logExplorer/LogExplorer.tsx | 8,419 | TypeScript/TSX | Desktop UI |
| crates/cd-core/src/log_analysis/ingest.rs | 7,557 | Rust | Rust crate: cd-core |
| crates/cd-core/src/log_analysis/exception_episodes.rs | 6,707 | Rust | Rust crate: cd-core |
| crates/cd-core/src/log_analysis/query.rs | 5,282 | Rust | Rust crate: cd-core |
| crates/cd-server/src/main.rs | 5,129 | Rust | Rust crate: cd-server |
| crates/cd-core/src/investigations/mod.rs | 4,641 | Rust | Rust crate: cd-core |
| desktop/src/lib/host.ts | 4,244 | TypeScript | Desktop UI |
| crates/cd-core/src/log_analysis/parse.rs | 3,680 | Rust | Rust crate: cd-core |
| desktop/src/components/logExplorer/LinkedChatRail.test.tsx | 3,633 | TypeScript/TSX | Desktop UI |
| crates/cd-core/src/investigations/report.rs | 3,488 | Rust | Rust crate: cd-core |
| desktop/src/components/panes/LogPane.test.tsx | 3,317 | TypeScript/TSX | Desktop UI |

## Dependency and design-health signals

- TypeScript/JavaScript resolved relative-import edges: **967**.
- Relative imports the lightweight resolver could not resolve: **6**.
- Same path-derived architecture-area edges: **39.5%** (382 edges).
- Decision tokens: **25,289**. This is a lexical
  control-flow density signal, not cyclomatic complexity and not a quality grade.

High fan-in files can be intentional shared boundaries or coupling hotspots:

| Imported path | Incoming edges |
| --- | --- |
| desktop/src/lib/host.ts | 109 |
| desktop/src/lib/activity/types.ts | 51 |
| desktop/src/lib/session/index.ts | 31 |
| desktop/src/lib/preflight.ts | 28 |
| desktop/src/components/icons.tsx | 16 |
| desktop/src/lib/skins.ts | 15 |
| desktop/src/components/wizards/types.ts | 14 |
| desktop/src/lib/logExplorer/types.ts | 13 |
| desktop/src/lib/turn.ts | 13 |
| desktop/src/hooks/useDismissibleLayer.tsx | 12 |

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
