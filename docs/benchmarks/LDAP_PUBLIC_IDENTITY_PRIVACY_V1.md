# LDAP public identity privacy v1

ContextDesk keeps the directory subject used for LDAP authentication and authorization inside the trusted server boundary. Ordinary API responses use an installation-local public identity such as `usr-0123456789abcdef0123456789abcdef`; they do not expose a user's LDAP or Active Directory distinguished name (DN).

## Stability and canonicalization

The public ID is an HMAC of a conservative canonical DN. Supported common case-insensitive naming attributes normalize attribute/value case, insignificant surrounding whitespace, repeated value whitespace, and Unicode compatibility form. For example, `CN=Example User, OU=People, DC=example, DC=test` and `cn=example user,ou=people,dc=example,dc=test` map to the same public ID within one installation.

ContextDesk does not guess when DN equivalence cannot be proved by this contract. Escaped, quoted, multi-valued, or otherwise ambiguous DN syntax fails closed at the public projection boundary instead of silently creating a second attribution identity. LDAP matching and authorization continue to use the original directory subject internally.

## Installation key

Production loads one durable 32-byte installation key. If `COLLAB_PUBLIC_IDENTITY_KEY` is not configured, the server atomically creates `public-identity-key` under `COLLAB_EVIDENCE_ROOT`. Unix installations reject a key readable by group or other users. Windows installations must protect the evidence root with an owner-only host ACL. Replicas must share the same configured key, and operators must back it up; losing or changing it changes public IDs but does not change LDAP authentication subjects.

The ephemeral codec is limited to isolated tests. The deterministic synthetic demo supplies its own fixture key. An authenticated production app refuses to start without the durable codec loaded by the server entry point.

## Public and administrative boundaries

Login/session, self-profile, investigation activity, timelines, ordinary exports, portable exports, errors, and other non-administrative API payloads are recursively projected, including DN text embedded in JSON strings. Public `actorId` filtering compares projected IDs directly and requires no reverse lookup.

Raw directory subjects are permitted only on successful, capability-protected directory configuration and diagnostic routes:

- `/api/admin/directory/identities/search`
- `/api/admin/directory/groups/search`
- `/api/admin/directory/mapping/preview`
- `/api/admin/ldap/config`
- `/api/admin/ldap/test`
- `/api/authz/group-role-map`

Denied or failed requests to those routes are sanitized. Existing stored rows are not rewritten: legacy DN attribution remains available for trusted correlation and projects through the durable key after reload.
