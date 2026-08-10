# Adversarial triage quality suite (v1)

Hermetic, synthetic fixtures for stress-testing retrieval and answer scoring.
Host-only `truth.json` never enters model-visible runtime packets.

This suite is separate from `open-v1` and does not rewrite its historical digest.

Run:

```bash
cargo run -p cd-core --bin cd-quality-eval-lab -- validate --suite fixtures/quality-eval/adversarial-v1
cargo run -p cd-core --bin cd-quality-eval-lab -- run --suite fixtures/quality-eval/adversarial-v1
```

Scripted retrieval rankings are ablation labels only — not claims about a real
embedding, hybrid, or reranking model.
