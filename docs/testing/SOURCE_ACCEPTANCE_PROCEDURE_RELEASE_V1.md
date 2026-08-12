# Source-based acceptance procedure — release-quality v2

Authoritative source:

- repository: `https://github.com/chriscase/ContextDesk.git`
- branch: `integrate/release-quality-v2`
- exact tested source/build SHA: `8b732d007a51a2624e363693fff555b609fd2456`

The exact tested source/build SHA above is the identity that must be fetched, built, and
verified. Do not substitute an older baseline, a moving branch tip, or an
unrelated local checkout. The live Vercel evidence is explicitly recorded
against the tested product-path ancestor
`aeaf5a7e7f686a6e4113f46ffaf24279d5073d89`; the later commits add only
deterministic quality-evaluation hardening and documentation. That live
evidence is not broadened into a universal provider claim.

This pin supersedes the earlier `c0935715…`, `85c065f0…`, and `64edb0a…`
acceptance inputs. Since those older pins, the release has added the chat-contract v4
transport/mode identity and fail-closed qualification, host-grounded fast
triage, bounded deadline controls, wider production rerank candidate handling,
and the current protected-file gateway diagnostic plumbing. Historical
live-provider reports for older SHAs are not evidence for this exact release.

This is the source-build path for a separate company machine. It does not
require an installer, a downloaded harness, or an OS credential store.

## 1. Preserve the existing checkout

Inspect the existing checkout and save any dirty work before proceeding. Fetch
the branch and create a new detached worktree at the exact SHA; do not reset,
clean, overwrite, reimport, or replace the owner's existing data/configuration.

Build from that isolated worktree:

```text
cargo build -p cd-cli --release --locked
```

The resulting binary is `target/release/contextdesk.exe` on Windows (or
`target/release/contextdesk` on Unix).

## 2. Prove build identity

Run `contextdesk --json capabilities` and stop unless `git_sha` equals the
exact SHA above. Keep the output local; it contains no credential value.

## 3. Preserve and inspect local state

Reuse the existing data directory, imported corpus, provider profile, and
configuration. Confirm the corpus and timezone read-only. The existing EDM
Server corpus is intentionally `Asia/Tokyo`; do not change it. Do not reimport.

Use the configured protected-file credential reference when available. Do not
paste a key into chat, print it, log it, or put it in an artifact. A
`file:` reference is sufficient and avoids Keychain access.

## 4. Discover and qualify one exact model

Use the configured company profile only:

```text
contextdesk --profile <profile> --json models discover
contextdesk --profile <profile> --model <exact-id-from-discovery> --json models verify <exact-id-from-discovery>
```

Start with the exact catalog ID returned for DeepSeek V4 Flash. Do not shorten
or infer the ID. Do not verify the whole catalog initially. A Vercel diagnostic
on the tested product-path ancestor passed `deepseek/deepseek-v4-flash` for
ordinary, structured, attachment, product-tool, and synthetic linked-log
triage; its separate direct native-tool continuation probe failed a response
contract, so no native-tools verified badge is implied. That evidence is
scoped to Vercel and must not be reused as an employer-gateway verdict.

## 5. Run one bounded product triage

Only if targeted verification passes, run exactly one user-initiated linked
triage turn against the existing corpus. Use the configured slow-model
allowance, up to ten minutes:

```text
contextdesk --profile <profile> --model <exact-deepseek-id> --deadline 600s \
  --jsonl chat --corpus <existing-corpus-id> "<owner's triage question>"
```

Keep the JSONL and share-safe diagnostic output local. Do not run a matrix,
automatic retry, reviewer mode, second model, embeddings, or reranking during
this focused acceptance turn. If the answer is empty, timed out, ungrounded,
or fails the typed triage contract, retain the safe trace and classify it as a
product/usefulness failure rather than guessing at a provider cause.

The release includes explicit inconclusive verdicts, exact model/profile
binding, protected-file credentials, adaptive deadlines, production-path
embedding/reranking adapters, and bounded reasoning-channel telemetry. The
release's Vercel evidence additionally passes Qwen3 Embedding 0.6B and Voyage
Rerank 2.5 Lite through those production adapters. Live employer compatibility,
answer usefulness, and any employer retrieval-role verdict still require this
machine's own gateway and corpus evidence.
