# Source-based acceptance procedure — release-quality v2

Authoritative source:

- repository: `https://github.com/chriscase/ContextDesk.git`
- branch: `integrate/triage-policy-sdk-v2`
- exact tested source/build SHA: `56994b6f5c41bb12702e1033daaec04dce0f7ae4`

The exact tested source/build SHA above is the identity that must be fetched, built, and
verified. Do not substitute an older baseline, a moving branch tip, or an
unrelated local checkout. There is not yet live Vercel evidence for this exact
runtime. The prior report
`docs/testing/VERCEL_DEEPSEEK_DIAGNOSTIC_2026-08-12_RELEASE_A3A5263E.md`
is historical evidence for the preceding code SHA only; it is useful
transport/product-path evidence, but it is not an employer-gateway
compatibility claim or evidence for this exact runtime.
Earlier `188e20a9ff35`, `601964de`, and `da231830` runs are also historical
context only.

This pin supersedes earlier acceptance inputs. Since those older pins, the
release has added the typed Triage Policy V2 graph and host resolver, shared
CLI/Tauri/TypeScript SDK seams, chat-contract v4 transport/mode identity and
fail-closed qualification, bounded deadline controls, production embedding and
rerank adapters, and the protected-file gateway diagnostic plumbing. This source
also fails closed when typed-contribution runtime preparation rejects instead of
silently falling back to a generic role path. Historical
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
current Vercel evidence is limited to the DeepSeek diagnostic described above;
it does not establish employer compatibility or retrieval-role readiness. Live
employer compatibility, answer usefulness, and any employer embedding/rerank
verdict still require this machine's own gateway and corpus evidence.
