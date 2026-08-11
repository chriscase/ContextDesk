#!/usr/bin/env python3
"""Run compile-valid hand mutations that cargo-mutants cannot express here.

Each mutation is applied to the production source, its focused regression is
run, and the original bytes are restored in a finally block. A successful test
run means the mutant survived; a failing test means it was killed. Compile
failures are reported separately as unviable rather than counted as kills.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Mutation:
    name: str
    file: str
    needle: str
    replacement: str
    test_filter: str
    occurrence: int = 0
    equivalent_reason: str | None = None


MUTATIONS = [
    Mutation(
        name="git_first_remote_fallback",
        file="crates/cd-core/src/git_source.rs",
        needle="""    remotes
        .iter()
        .find(|(_, url)| is_canonical_contextdesk_remote(url))
        .cloned()
""",
        replacement="    remotes.first().cloned()\n",
        test_filter="select_canonical_never_first_remote_fallback",
    ),
    Mutation(
        name="git_timeout_omit_terminate",
        file="crates/cd-core/src/git_source.rs",
        needle="                    terminate_git_child(&mut child);\n",
        replacement="",
        test_filter="git_timeout_kills_child_before_delayed_mutation",
    ),
    Mutation(
        name="context_prepare_skip_final_fit",
        file="crates/cd-core/src/sessions.rs",
        needle="    let fitted = fit_model_context_to_budget(&model_ctx, budget)?;\n",
        replacement="    let fitted = model_ctx.clone();\n",
        test_filter="prepare_model_context",
    ),
    Mutation(
        name="context_ambient_skip_refit",
        file="crates/cd-core/src/agent.rs",
        needle="                        if let Err(e) = enforce_hard_context_budget(&mut model_ctx, char_budget) {\n",
        replacement="                        if let Err(e) = Ok::<(), String>(()) {\n",
        test_filter="agent_ambient_near_ceiling_stays_under_hard_budget",
    ),
    Mutation(
        name="context_prefetch_skip_refit",
        file="crates/cd-core/src/agent.rs",
        needle=(
            "                            if let Err(e) = "
            "enforce_hard_context_budget(&mut model_ctx, char_budget)\n"
            "                            {\n"
        ),
        replacement="                            if let Err(e) = Ok::<(), String>(()) {\n",
        test_filter="agent_tools_disabled_prefetch_stays_under_hard_budget",
    ),
    Mutation(
        name="context_remove_final_provider_gate",
        file="crates/cd-core/src/agent.rs",
        needle=(
            "            if estimate_context_chars(&model_ctx) "
            "> char_budget {\n"
        ),
        replacement="            if false {\n",
        test_filter="agent_prepare_path_hard_total_context_budget",
        equivalent_reason=(
            "single-site removal is redundant with the preparation and post-injection "
            "fit gates on every current provider path; separate ambient and prefetch "
            "omission mutants prove those upstream gates independently"
        ),
    ),
    Mutation(
        name="memory_tags_skip_credential_block",
        file="crates/cd-core/src/memory/sqlite_store.rs",
        needle="        if r.blocked {\n",
        replacement="        if false && r.blocked {\n",
        test_filter="tag_secret_blocked_on_insert",
        occurrence=2,
    ),
    Mutation(
        name="memory_tags_skip_mixed_redaction",
        file="crates/cd-core/src/memory/sqlite_store.rs",
        needle="        let cleaned = if r.redacted {\n",
        replacement="        let cleaned = if false && r.redacted {\n",
        test_filter="tag_mixed_content_redacted_or_blocked",
    ),
    Mutation(
        name="memory_replace_tags_bypass_sanitizer",
        file="crates/cd-core/src/memory/sqlite_store.rs",
        needle="    let tags = sanitize_memory_tags(tags)?;\n",
        replacement="    let tags = tags.to_vec();\n",
        test_filter="tag_secret_blocked_on_update_meta",
    ),
    Mutation(
        name="memory_cleanup_ignore_remove_failure",
        file="crates/cd-core/src/memory/facade.rs",
        needle="        if let Err(e) = cleanup.remove_path(p) {\n",
        replacement="        if let Err(e) = Ok::<(), std::io::Error>(()) {\n",
        test_filter="legacy_cleanup_failure_surfaces_and_blocks_attach",
    ),
    # --- host-grounded fast triage -----------------------------------------
    # Each of these removes exactly one promise the route makes, so a survivor
    # would mean the promise is documented but not enforced.
    Mutation(
        name="fast_triage_validator_bypass",
        file="crates/cd-core/src/fast_triage/validate.rs",
        needle="""    if categories.is_empty() {
        FastTriageValidation::Accepted(Box::new(envelope))
    } else {
        FastTriageValidation::Rejected(categories.into_iter().collect())
    }
""",
        replacement="    FastTriageValidation::Accepted(Box::new(envelope))\n",
        test_filter="each_recorded_causal_failure_is_caught_with_its_own_category",
    ),
    Mutation(
        name="fast_triage_second_correction",
        file="crates/cd-core/src/fast_triage/route.rs",
        needle="        self.max_corrections.min(FAST_TRIAGE_MAX_CORRECTIONS)\n",
        replacement="        self.max_corrections\n",
        test_filter="the_correction_is_bounded_at_one_however_config_is_set",
    ),
    Mutation(
        name="fast_triage_escalation_evidence_mutation",
        file="crates/cd-core/src/fast_triage/route.rs",
        needle="""    let escalation_messages = fast_triage_messages(
        inputs.user_text,
        packet,
        &evidence_block,
        categories.first().copied(),
    );
""",
        replacement="""    let escalation_messages = fast_triage_messages(
        inputs.user_text,
        packet,
        &fast_triage_evidence_block(packet),
        categories.first().copied(),
    );
""",
        test_filter="an_authorized_escalation_succeeds_with_a_byte_identical_packet",
    ),
    Mutation(
        name="fast_triage_silent_gateway_switch",
        file="crates/cd-core/src/fast_triage/route.rs",
        needle="        (Some(fallback), Some(backend)) if fallback.authorized => Some((fallback, backend)),\n",
        replacement="        (Some(fallback), Some(backend)) => Some((fallback, backend)),\n",
        test_filter="an_unauthorized_fallback_is_never_called",
    ),
    Mutation(
        name="fast_triage_reasoning_into_visible_answer",
        file="crates/cd-core/src/fast_triage/terminal.rs",
        needle="        let (reasoning, visible) = split_complete_reasoning_prefix(raw);\n",
        replacement="        let (reasoning, visible) = (String::new(), raw.trim().to_string());\n",
        test_filter="a_reasoning_only_terminal_is_empty_not_a_pass",
    ),
    Mutation(
        name="fast_triage_reasoning_into_debug_projection",
        file="crates/cd-core/src/fast_triage/terminal.rs",
        needle="            .field(\"reasoning_chars\", &self.reasoning.chars().count())\n",
        replacement="            .field(\"reasoning_chars\", &self.reasoning)\n",
        test_filter="reasoning_stays_in_its_own_channel_and_never_becomes_visible",
    ),
]


def replace_occurrence(text: str, mutation: Mutation) -> str:
    starts: list[int] = []
    offset = 0
    while True:
        found = text.find(mutation.needle, offset)
        if found < 0:
            break
        starts.append(found)
        offset = found + len(mutation.needle)
    if mutation.occurrence >= len(starts):
        raise RuntimeError(
            f"{mutation.name}: expected occurrence {mutation.occurrence}, "
            f"found {len(starts)} matches"
        )
    start = starts[mutation.occurrence]
    end = start + len(mutation.needle)
    return text[:start] + mutation.replacement + text[end:]


def run_mutation(mutation: Mutation, timeout: int) -> dict[str, object]:
    path = ROOT / mutation.file
    original = path.read_text(encoding="utf-8")
    mutated = replace_occurrence(original, mutation)
    started = time.monotonic()
    try:
        path.write_text(mutated, encoding="utf-8")
        command = [
            "cargo",
            "test",
            "-p",
            "cd-core",
            mutation.test_filter,
            "--",
            "--nocapture",
        ]
        completed = subprocess.run(
            command,
            cwd=ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        output = completed.stdout
        if completed.returncode == 0:
            outcome = "equivalent" if mutation.equivalent_reason else "survived"
        elif "could not compile" in output:
            outcome = "unviable"
        else:
            outcome = "killed"
        return {
            **asdict(mutation),
            "command": command,
            "outcome": outcome,
            "returncode": completed.returncode,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "output": output,
        }
    except subprocess.TimeoutExpired as error:
        return {
            **asdict(mutation),
            "outcome": "timeout",
            "returncode": None,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "output": (error.stdout or "") + (error.stderr or ""),
        }
    finally:
        path.write_text(original, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument(
        "--tested-sha",
        default="HEAD",
        help="commit whose mutation-target bytes must match the worktree",
    )
    args = parser.parse_args()

    tested_sha = subprocess.check_output(
        ["git", "rev-parse", args.tested_sha], cwd=ROOT, text=True
    ).strip()
    target_files = sorted({mutation.file for mutation in MUTATIONS})
    target_diff = subprocess.run(
        ["git", "diff", "--quiet", tested_sha, "--", *target_files],
        cwd=ROOT,
        check=False,
    )
    if target_diff.returncode != 0:
        parser.error(
            f"mutation targets differ from tested commit {tested_sha}; "
            "commit or restore them before running"
        )

    results = []
    for mutation in MUTATIONS:
        print(f"MUTATE {mutation.name}", flush=True)
        result = run_mutation(mutation, args.timeout)
        results.append(result)
        print(
            f"{str(result['outcome']).upper():9} {mutation.name} "
            f"({result['elapsed_seconds']}s)",
            flush=True,
        )

    counts = {
        outcome: sum(result["outcome"] == outcome for result in results)
        for outcome in ("killed", "equivalent", "survived", "timeout", "unviable")
    }
    payload = {
        "tool": "scripts/mutation/manual_high_risk.py",
        "tested_sha": tested_sha,
        "counts": counts,
        "results": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(counts, sort_keys=True))
    return 0 if counts["survived"] == counts["timeout"] == counts["unviable"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
