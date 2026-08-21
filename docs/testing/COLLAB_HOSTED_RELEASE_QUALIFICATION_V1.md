# ContextDesk hosted collaboration qualification

The `collab-qualify` workflow is a release-readiness check for the collaborative
war room. It runs on Node 22 with a PostgreSQL 16 service and exercises the same
qualification harness against both memory and PostgreSQL storage.

It verifies:

- contracts, server, and web typechecking, linting, tests, and builds;
- the complete synthetic qualification workflow on memory storage;
- the same workflow against a disposable PostgreSQL database;
- configuration initialization and doctor output; and
- that retained JSON artifacts are typed, share-safe, and provider-free.

The workflow deliberately does not contact LDAP, Vercel, employer gateways, or
any model provider. `COLLAB_LIVE_VERCEL=0`, no live profile catalog is supplied,
and the sanitizer rejects any live provider lane. A green run proves hosted
application/storage readiness, not model quality or the usefulness of a triage.

Only sanitized reports are uploaded, for 14 days. Raw output, prompts, captures,
credentials, endpoints, request IDs, and private host details are rejected before
upload. Provider-backed qualification remains an explicit operator action through
`npm run qualify:live`, with separate consent and host-bridge requirements.
