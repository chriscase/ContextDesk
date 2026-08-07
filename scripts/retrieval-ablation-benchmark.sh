#!/usr/bin/env bash
#
# Retrieval-ablation benchmark runner.
#
# Deterministic hidden-truth benchmark for the incremental value of
# structured/keyword retrieval, semantic embeddings, reranking, and bounded
# multi-stage analysis. Offline: no network, credentials, providers, or model
# downloads. Docs: docs/benchmarks/MULTI_MODEL_RETRIEVAL_BENCHMARK.md
#
# Usage:
#   scripts/retrieval-ablation-benchmark.sh small     # CI-grade: regen check + baseline + mutations
#   scripts/retrieval-ablation-benchmark.sh medium    # generate ~250k-event corpus on demand (local only)
#   scripts/retrieval-ablation-benchmark.sh large     # generate >=1M-event corpus on demand (local only)
#   scripts/retrieval-ablation-benchmark.sh estimate  # disk estimates, no files written

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="${HOME}/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
export CD_GIT_SHA="${CD_GIT_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"

TIER="${1:-small}"

case "$TIER" in
  small)
    # The exact gates CI runs for this suite: frozen regeneration, truth
    # isolation, conservation, baseline scoring vs the committed golden,
    # false-green mutations, contract pluggability, production-rubric gates.
    cargo test -p cd-core --test retrieval_ablation_lab -- --nocapture
    echo "RETRIEVAL_ABLATION_SMALL_PASS sha=$CD_GIT_SHA"
    ;;
  medium)
    echo "Generating the ~250k-event medium tier under fixtures/log-lab/generated/ (git-ignored)."
    echo "Resource note: ~45 MiB on disk, a few seconds of CPU. Never commit generated trees."
    cargo test -p cd-core --test retrieval_ablation_lab \
      generate_medium_tier_corpus_on_demand -- --ignored --nocapture
    echo "RETRIEVAL_ABLATION_MEDIUM_GENERATED root=fixtures/log-lab/generated/retrieval-ablation/medium"
    ;;
  large)
    echo "Generating the >=1M-event large tier under fixtures/log-lab/generated/ (git-ignored)."
    echo "RESOURCE WARNING: ~200 MiB on disk. Check free space first (df -h). Never commit generated trees."
    cargo test -p cd-core --test retrieval_ablation_lab \
      generate_large_tier_corpus_on_demand -- --ignored --nocapture
    echo "RETRIEVAL_ABLATION_LARGE_GENERATED root=fixtures/log-lab/generated/retrieval-ablation/large"
    ;;
  estimate)
    cargo run -q -p cd-core --example generate_log_lab -- --profile retrieval-ablation --tier small --estimate-only
    cargo run -q -p cd-core --example generate_log_lab -- --profile retrieval-ablation --tier medium --estimate-only
    cargo run -q -p cd-core --example generate_log_lab -- --profile retrieval-ablation --tier large --estimate-only
    echo "RETRIEVAL_ABLATION_ESTIMATE_OK"
    ;;
  *)
    echo "usage: $0 [small|medium|large|estimate]" >&2
    exit 2
    ;;
esac
