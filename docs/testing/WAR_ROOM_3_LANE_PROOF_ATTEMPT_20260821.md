# War-Room 3-lane same-snapshot proof — attempt log (2026-08-21)

Owner-local only. Not a live run. No product code changed.

## Ref verified

`origin/merge/war-room-pilot` = `b93dc17ba2e13225d54f0193ecdf3872998082e6`,
confirmed by fetch + `git rev-parse`, and confirmed as an ancestor of this
worktree's HEAD (same commit) before any other step ran.

## Objective

Same-snapshot `contextdesk bench-compare` across exactly the employer lane
ids `qwen-3.6-27b`, `gpt-oss-120b`, `ministral-3-14b-instruct-2512`, Vercel
gateway allowed, DeepSeek rejected.

## Finding: no host profiles are configured for these aliases

Searched, on this machine, for an AppConfig profile file:

- `$CONTEXTDESK_CONFIG` — unset;
- `$XDG_CONFIG_HOME` — unset, and `~/.config/contextdesk*` — absent;
- project `.contextdesk.toml` (this worktree and the main checkout) — absent;
- `~/Library/Application Support/contextdesk/` — present, but contains only
  `secrets/vercel-gateway.key` (a raw key file, not a registered profile) and
  `diagnostics/{luna,deepseek}/*` run history. Neither alias namespace nor any
  `.toml`/profile-catalog file exists there.

No `.contextdesk.toml` exists anywhere searched, so no AppConfig profile —
for these three aliases or any other id — is currently registered. A Vercel
catalog id (e.g. `alibaba/qwen3.6-27b`) is a different provider/id and is not
a substitute for the employer gateway alias per
[`EMPLOYER_MODEL_ROLE_EXPERIMENTS_V1.md`](../benchmarks/EMPLOYER_MODEL_ROLE_EXPERIMENTS_V1.md).

## Action taken

None. No `bench-compare` invocation was attempted, and no dummy/fabricated
lane result was created. Per instructions, stopping here rather than
inventing a result.

## What's needed to unblock (no secrets below)

For each of `qwen-3.6-27b`, `gpt-oss-120b`, `ministral-3-14b-instruct-2512`:

1. A Keychain entry `provider/<id>/api_key` (or an owner-only mode-600
   protected `file:` reference) on the employer gateway.
2. A registered AppConfig profile pointing at it, e.g.
   `contextdesk config init --profile-id <id> --provider-kind <kind> --base-url <url> --api-key-ref provider/<id>/api_key`.
3. `contextdesk --profile <id> models verify` passing for that profile before
   it's used as a `bench-compare` candidate.

Once all three profiles verify, re-run this proof with
`contextdesk bench-compare --library <dir> --task <task-id> --candidate <a.json> --candidate <b.json> --candidate <c.json>`
naming the three profile ids.
