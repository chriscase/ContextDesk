---
id: war-room-s3-evidence-store
title: Use a self-hosted S3-compatible War Room evidence store
summary: Configure and qualify an S3-compatible War Room evidence store, evaluate it locally, and keep credentials and metadata authority off the browser.
section: war-room
tags:
  - war-room
  - s3
  - evidence
  - deployment
  - process
  - collaboration
order: 32
related:
  - war-room-deployment
  - war-room-evidence-review
  - s3-backup
  - security-boundaries
---

# Use a self-hosted S3-compatible War Room evidence store

War Room keeps investigation metadata, authorization, and audit in the
collaboration database. Evidence **bytes** are a separate backend. Filesystem
storage under `COLLAB_EVIDENCE_ROOT` remains the default; deployments may
instead select an S3-compatible bucket or assigned prefix.

This page is the operator guide for that S3 byte store. It describes the
ContextDesk configuration contract and a local evaluation, but it does not
certify any object-store vendor.

![A compatible object store holds evidence bytes, the War Room service keeps host credentials, and the database remains authoritative for metadata and authorization](../assets/war-room-s3-evidence-store.svg)

> Important:
> Filesystem storage remains the default War Room evidence provider. An
> object-store CLI success alone is not War Room integration; complete the
> application-level checks below before enabling S3 for a real instance.

## Choose the right S3 feature

| Job | Use | Do not treat as the same thing |
| --- | --- | --- |
| Default War Room evidence bytes | Filesystem volume at `COLLAB_EVIDENCE_ROOT` | Desktop Settings → Backup or a public CDN bucket |
| S3-backed War Room evidence bytes | A dedicated S3-compatible bucket or prefix that satisfies the contract below | Desktop Settings → Backup, or an object-store CLI smoke test by itself |
| Local API qualification | A loopback evaluation service with persistent volumes (Garage is the example here) | A one-node Compose file copied into production |
| Desktop workspace export | help://s3-backup Phase A backup/export | War Room evidence storage, restore, or an S3 index source |

## Compatibility contract

Start vendor-neutral. Any S3-compatible service may be evaluated if it
satisfies this contract. Passing the contract is not a ContextDesk
certification.

| Requirement | What to prove |
| --- | --- |
| Dedicated location | Prefer a private bucket used only for War Room. A dedicated prefix is acceptable only when the provider can enforce that prefix boundary for the service identity |
| Endpoint and region | A stable API endpoint and a region string the client and server both use for signing |
| Path-style addressing | Local and many self-hosted endpoints need path-style requests (`/bucket/key`). Virtual-hosted `bucket.hostname` names often fail on loopback |
| TLS and trust | Production traffic uses TLS. If the certificate is issued by an internal CA, the **War Room process** trust store must include that CA |
| Stable DNS | The name the War Room service uses must keep resolving to the intended hosts. Do not put credentials in the URL |
| Least-privilege identity | A dedicated service identity with only the read, write, list, and multipart actions the shipped provider requires, scoped to that bucket or prefix. No console root, browser user, or unused bucket-admin APIs |
| Non-browser credentials | Access keys stay in a secret manager or owner-only files on the host. They never enter the webview, Help, git, or screenshots |
| Persistence | Metadata and object bytes survive process and container restarts on durable volumes |
| Capacity and monitoring | Disk, inode, and object-count headroom with alerts before the store is full |
| Backup and recovery | A tested restore of object bytes and store metadata together with the collaboration database. Replication and versioning are not backups |
| Credential rotation | A dedicated War Room identity; overlapping keys or a short write freeze; never rotate by putting a key in a URL |
| Upgrades | Pinned image or package tags and that product's version-specific upgrade notes. Do not run unversioned `latest` |
| Verified S3 operations | Independent proof of put, head, get, range get, list, and disposable-object delete, plus a hash match |

The object store contains evidence bytes. The database remains authoritative
for investigation identity, permissions, provenance, and whether a case
believes an artifact exists. Object user-metadata is not a substitute for
database rows.

The S3 provider keeps canonical blobs, staging objects, pending-write journals,
and file-server reference records below the assigned prefix. The collaboration
database remains authoritative for case membership, permissions, provenance,
and artifact metadata. `COLLAB_EVIDENCE_ROOT` remains a protected local control
root even in S3 mode; do not expose either location to the browser.

### Least-privilege policy shape

Policy syntax is provider-specific. For services that accept AWS-style IAM
policies, this is a starting shape rather than a provider-neutral copy/paste
policy. Replace the bucket and prefix and verify it against the selected S3
service. ContextDesk requires `s3:DeleteObject` for staging, journal recovery,
and rollback cleanup; it does not require bucket-administration permissions.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListAssignedPrefix",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::war-room-evidence"],
      "Condition": {
        "StringLike": { "s3:prefix": ["assigned-prefix/*"] }
      }
    },
    {
      "Sid": "ReadWriteAssignedObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": ["arn:aws:s3:::war-room-evidence/assigned-prefix/*"]
    }
  ]
}
```

Some self-hosted services expose coarser bucket grants instead of IAM JSON.
Use the smallest native grant that passes the release's readiness and
application smoke tests. The application identity must be able to delete only
objects below its assigned prefix; this is internal transaction cleanup, not a
user-facing permanent-delete feature. Keep bucket administration and unrelated
prefixes out of the application grant.

## Operator settings translation

These names are the S3 Evidence Storage v1 deployment contract. The commented
examples in `collab/deploy/.env.example` remain the copy-ready source of truth.
Filesystem is the default, and `COLLAB_EVIDENCE_ROOT` remains the local
control-state root in both modes.

| Operator job | Setting | Notes |
| --- | --- | --- |
| Select byte backend | `COLLAB_EVIDENCE_PROVIDER` | `filesystem` (default) or `s3`. |
| Filesystem/control root | `COLLAB_EVIDENCE_ROOT` | Required in both modes for local control state. |
| S3 API endpoint | `COLLAB_EVIDENCE_S3_ENDPOINT` | Scheme, host, and port only. No userinfo, no key in the query string. |
| Region | `COLLAB_EVIDENCE_S3_REGION` | Must match the signer. Garage's default region is `garage`. |
| Bucket | `COLLAB_EVIDENCE_S3_BUCKET` | Private bucket dedicated to War Room when possible. |
| Key prefix | `COLLAB_EVIDENCE_S3_PREFIX` | Optional isolation inside a shared bucket. Keep smoke-test keys out of the application prefix. |
| Path-style | `COLLAB_EVIDENCE_S3_FORCE_PATH_STYLE` | Use `1` for Garage and other endpoints that do not provide bucket-name DNS. |
| HTTP opt-in | `COLLAB_EVIDENCE_S3_ALLOW_HTTP` | Defaults off. Set to `1` only for a trusted local evaluation network. |
| Request timeout | `COLLAB_EVIDENCE_S3_TIMEOUT_MS` | Bounded per-request timeout; the deployment sample uses 30 seconds. |
| Upload ceiling | `COLLAB_EVIDENCE_MAX_UPLOAD_BYTES` | Defaults to 512 MiB and refuses values above the 5 GiB v1 hard limit. |
| Credential mode | `COLLAB_EVIDENCE_S3_CREDENTIALS_MODE` | `static` requires the explicit values below; `default_chain` uses the server process's AWS-compatible provider chain. |
| Access key id | `COLLAB_EVIDENCE_S3_ACCESS_KEY_ID`, `_FILE`, or `_REF` | Dedicated service identity, not a human console login. Configure exactly one source. |
| Secret access key | `COLLAB_EVIDENCE_S3_SECRET_ACCESS_KEY`, `_FILE`, or `_REF` | Configure exactly one source; files must be owner-protected and `_REF` must be an absolute `file:` reference. |
| Session token | `COLLAB_EVIDENCE_S3_SESSION_TOKEN`, `_FILE`, or `_REF` | Optional; use only when the selected static credentials require it. |
| Custom CA | `COLLAB_EVIDENCE_S3_CA_FILE` | Optional PEM file for the private S3 endpoint. TLS verification remains enabled. |

## Local evaluation with Garage

Use a local evaluation to prove the S3 API, persistence, and path-style
behavior. It is not a production topology and it is not a War Room integration
test.

This guide uses [Garage](https://garagehq.deuxfleurs.fr/documentation/quick-start/)
v2.3.0 (`dxflrs/garage:v2.3.0`) as the worked example because it is an
actively documented S3-compatible server with a single-node evaluation mode.
That is not a vendor certification. Other compatible services may be used if
they meet the contract.

Garage v2.3.0 supports `garage server --single-node --default-bucket` with
`GARAGE_DEFAULT_ACCESS_KEY`, `GARAGE_DEFAULT_SECRET_KEY`, and
`GARAGE_DEFAULT_BUCKET`. The official Quick Start warns that single-node
mode has **no redundancy**, and its minimal container example does not mount
persistent volumes. Evaluation here therefore binds the S3 API to loopback,
pins the image tag, mounts metadata and data directories, and keeps secrets
out of git.

Read the upstream pages before copying anything:

- [Garage Quick Start](https://garagehq.deuxfleurs.fr/documentation/quick-start/)
- [Garage real-world cookbook](https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/)

> Caution:
> Single-node Garage is for qualification on one machine. It has no
> redundancy. Do not reuse this Compose file as a shared War Room store.

### Persistent loopback example

Create three owner-only files/directories in a disposable working directory:
`garage.toml`, `.garage-eval.env`, and persistent metadata/data directories.
None belongs in git. Garage needs its configuration file as well as the two
durable mounts; mounting only `/var/lib/garage/data` is not sufficient.

Use this evaluation configuration. Replace `replace-with-64-hex-characters`
with the output of `openssl rand -hex 32`; keep the file owner-readable only.

```toml
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "replace-with-64-hex-characters"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"
```

Then save this as `compose.yaml` in the same directory:

```yaml
services:
  garage:
    image: dxflrs/garage:v2.3.0
    command: ["/garage", "server", "--single-node", "--default-bucket"]
    restart: unless-stopped
    env_file:
      - ./.garage-eval.env
    ports:
      - "127.0.0.1:3900:3900"
    volumes:
      - ./garage.toml:/etc/garage.toml:ro
      - ./garage-meta:/var/lib/garage/meta
      - ./garage-data:/var/lib/garage/data
```

Create the directories, then generate the RPC secret:

```sh
umask 077
mkdir -p garage-meta garage-data
chmod 600 garage.toml
openssl rand -hex 32
```

Put that value into `rpc_secret` in `garage.toml`. Stop if the placeholder
`replace-with-64-hex-characters` is still present — do not start Compose
until it is gone. Then write evaluation-only bootstrap keys (Garage
access-key ids must start with `GK`) and start:

```sh
umask 077
if grep -q 'replace-with-64-hex-characters' garage.toml; then
  printf 'replace rpc_secret before starting\n' >&2
  exit 1
fi
printf 'GARAGE_DEFAULT_ACCESS_KEY=GK%s\n' "$(openssl rand -hex 16)" > .garage-eval.env
printf 'GARAGE_DEFAULT_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" >> .garage-eval.env
printf 'GARAGE_DEFAULT_BUCKET=war-room-evidence\n' >> .garage-eval.env
docker compose up -d
docker compose exec garage /garage status
```

The env file is acceptable only for this owner-operated evaluation; Docker can
show container environment values to local Docker administrators. Use the
deployment platform's secret manager for production and remove the bootstrap
values after replacing the default key with an operator-managed application
identity according to Garage's current documentation.

The conventional Garage paths `/var/lib/garage/meta` and
`/var/lib/garage/data` come from the real-world cookbook layout. After the
first put, confirm the mounted `garage-data` directory changes and that the
object survives `docker compose restart garage`. If the selected image version
documents different paths, follow that version's documentation instead.

The S3 API listens on port **3900**. Garage's default region string is
`garage`. Leave RPC, admin, and website ports unpublished on the host.

Loopback publishing is correct for **object-store** evaluation from the same
host. A War Room **container** does not reach `127.0.0.1:3900` on the host; see
Troubleshooting.

### Object-store smoke test

This proves the S3 service, not War Room. Use a disposable prefix such as
`operator-smoke/` so later application keys cannot collide. Prefer a
least-privilege smoke identity. The application identity also requires delete
within its assigned prefix for transactional cleanup, but it must not receive
bucket-administration access.

1. Configure an S3 client for path-style requests, endpoint
   `http://127.0.0.1:3900`, and region `garage`. Disable instance-metadata
   credential fallback so the client cannot pick up unrelated keys.
2. Put a small unique object under `operator-smoke/`.
3. Head the object and confirm size.
4. Get the full object and a range of the same object.
5. List the prefix and confirm the key is present.
6. Hash the downloaded bytes and compare them with the original.
7. Restart the Garage container, then get the same object again.
8. Delete the smoke object and confirm a later head fails.
9. Confirm the data landed on the mounted data directory.

A typical AWS CLI shape for this evaluation (any SigV4 S3 client is
acceptable). Load the keys generated above; do not print them. The scoped
config file forces path-style addressing so the client does not call
`bucket.127.0.0.1`.

```sh
umask 077
AWS_ACCESS_KEY_ID="$(sed -n 's/^GARAGE_DEFAULT_ACCESS_KEY=//p' .garage-eval.env)"
AWS_SECRET_ACCESS_KEY="$(sed -n 's/^GARAGE_DEFAULT_SECRET_KEY=//p' .garage-eval.env)"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
export AWS_DEFAULT_REGION=garage
export AWS_EC2_METADATA_DISABLED=true
export AWS_CONFIG_FILE="$PWD/.garage-eval-aws.config"
cat > "$AWS_CONFIG_FILE" <<'EOF'
[default]
region = garage
s3 =
    addressing_style = path
EOF
ENDPOINT=http://127.0.0.1:3900
BUCKET=war-room-evidence
KEY="operator-smoke/eval-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4).txt"
printf 'war-room-s3-eval\n' > /tmp/war-room-s3-eval.txt

aws --endpoint-url "$ENDPOINT" --region garage s3api put-object --bucket "$BUCKET" --key "$KEY" --body /tmp/war-room-s3-eval.txt
aws --endpoint-url "$ENDPOINT" --region garage s3api head-object --bucket "$BUCKET" --key "$KEY"
aws --endpoint-url "$ENDPOINT" --region garage s3api get-object --bucket "$BUCKET" --key "$KEY" /tmp/war-room-s3-eval-out.txt
aws --endpoint-url "$ENDPOINT" --region garage s3api get-object --bucket "$BUCKET" --key "$KEY" --range bytes=0-6 /tmp/war-room-s3-eval-range.txt
aws --endpoint-url "$ENDPOINT" --region garage s3api list-objects-v2 --bucket "$BUCKET" --prefix operator-smoke/
SOURCE_SHA256="$(openssl dgst -sha256 -r /tmp/war-room-s3-eval.txt | awk '{print $1}')"
DOWNLOADED_SHA256="$(openssl dgst -sha256 -r /tmp/war-room-s3-eval-out.txt | awk '{print $1}')"
test "$SOURCE_SHA256" = "$DOWNLOADED_SHA256"
docker compose restart garage
docker compose exec garage /garage status
aws --endpoint-url "$ENDPOINT" --region garage s3api get-object --bucket "$BUCKET" --key "$KEY" /tmp/war-room-s3-eval-restart.txt
RESTART_SHA256="$(openssl dgst -sha256 -r /tmp/war-room-s3-eval-restart.txt | awk '{print $1}')"
test "$SOURCE_SHA256" = "$RESTART_SHA256"
aws --endpoint-url "$ENDPOINT" --region garage s3api delete-object --bucket "$BUCKET" --key "$KEY"
if aws --endpoint-url "$ENDPOINT" --region garage s3api head-object --bucket "$BUCKET" --key "$KEY"; then exit 1; fi
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION AWS_EC2_METADATA_DISABLED AWS_CONFIG_FILE
rm -f .garage-eval-aws.config /tmp/war-room-s3-eval.txt /tmp/war-room-s3-eval-out.txt /tmp/war-room-s3-eval-range.txt /tmp/war-room-s3-eval-restart.txt
```

Do not print secret values, and do not capture CLI debug logs that replay
authorization headers. A later production-shaped check should read keys from
the platform secret manager or owner-only files, not from `.garage-eval.env`.

## Production planning

A one-node evaluation Compose file is not production. Do not scale it by
publishing port 3900 or sharing its keys.

If you run Garage in production, treat the [real-world cookbook](https://garagehq.deuxfleurs.fr/documentation/cookbook/real-world/)
as the current Garage example: at least three nodes, three-way replication,
fixed image tags, directly reachable node networking, and the version-specific
upgrade documentation. That is Garage's guidance, not a universal requirement
for every compatible product. Other services have their own clustering and
upgrade rules.

Every production-shaped work-server deployment, Garage or otherwise, still
needs:

| Control | Production expectation |
| --- | --- |
| TLS | Terminate TLS at an ingress, reverse proxy, or equivalent. Do not offer plaintext S3 on a reachable network |
| Network | Private network or firewall so only the War Room service (and operators) can reach the API |
| Persistence | Durable data and metadata volumes, independently snapshottable |
| Backup | A tested backup and recovery design for **both** object bytes and store metadata. Replication is not a backup. Bucket versioning is not a backup |
| DNS | Stable names that match certificates and the configured endpoint |
| Monitoring | Reachability, TLS expiry, disk/object capacity, error rates, and replication health where the product provides it |
| Alerts | Capacity alerts before writes start failing |
| Recovery | A restore rehearsal with hash comparison of sample objects |
| Change | Staged upgrade and rollback using the vendor's version-specific notes and pinned tags |

War Room itself does not terminate TLS for the collaboration HTTP socket; see
help://war-room-deployment. The object-store TLS session is a separate
connection owned by the War Room process.

## Secrets, credentials, and rotation

Use a deployment secret manager or owner-only mounted secret files. Never
commit credentials, put them in a URL, type them into the browser, paste them
into logs, or leave them in screenshots or ordinary env examples.

Give War Room a dedicated service identity. Do not reuse a human key, a
node-admin key, or the identity used for desktop Settings → Backup.

Where the object store supports two live keys:

1. Create a new key for the same identity or an equivalent least-privilege
   identity. Leave the old key active.
2. Prove the new key with the object-store smoke test.
3. Update the War Room secret source from `collab/deploy/.env.example` (file,
   absolute `file:` reference, or secret manager).
4. Restart or reload the War Room process as the release requires.
5. Confirm an application-level read of a known object.
6. Revoke the old key.
7. Verify the old key is rejected and the new key still works.

If the store cannot overlap two keys, schedule a short write freeze, switch,
and re-verify. Do not rotate by appending a key to a URL or by sharing the
new secret through chat.

## Health verification and smoke tests

Keep these two proofs separate.

| Proof | What it shows | What it does not show |
| --- | --- | --- |
| Object-store CLI smoke test | The service accepts signed requests, persists bytes, and honors get/head/range/list/delete on a disposable key | That War Room can configure, authorize, or hash evidence |
| Provider readiness | The War Room process accepted its config and `ping`/ready checks for the byte backend | That historical objects were migrated or that backups restore |
| Bucket and prefix permissions | The dedicated identity can reach only the assigned location | That another identity is locked out unless you test that separately |
| Application upload/download | An authorized War Room action stored bytes and read them back with a matching hash | Lifecycle, legal hold, or multi-provider failover |

After the CLI proof plus persistence across restart, add:

1. Process configuration accepted from `collab/deploy/.env.example`.
2. Readiness of the configured byte backend.
3. Permission check against the assigned bucket or prefix.
4. A small unique application upload, head, download, and hash compare.
5. Restart of War Room and the object store, then another download of the same
   artifact.
6. Cleanup only of disposable smoke objects. The current evidence interface
   does not offer general deletion; do not invent a production delete path.

## Troubleshooting

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| TLS handshake failure or unknown CA | Custom CA not in the War Room process trust store; hostname mismatch | Certificate names, `NODE_EXTRA_CA_CERTS` or the release CA setting, and that you are not pointing at HTTP |
| SignatureDoesNotMatch or similar | Wrong secret, clock skew, or region mismatch | Region string (`garage` for the example), key material, and host NTP |
| Permanent redirect or NoSuchBucket on a URL that includes the bucket hostname | Client used virtual-hosted addressing | Force path-style; local services rarely serve `bucket.127.0.0.1` |
| AccessDenied / 403 | Identity lacks the operation, or the prefix/bucket is wrong | Scope of the service identity; smoke prefix versus application prefix |
| Clock skew rejected | Host time off by more than the store's SigV4 window | NTP on War Room hosts and object-store nodes |
| Connection refused from War Room, works on the host | Endpoint is loopback in a different network namespace | From the War Room container, `127.0.0.1` is that container. Use a compose network name, host gateway, or publish on an address that namespace can reach |
| Missing object, database row exists | Prefix, bucket, or key layout mismatch; bytes never persisted | Head the exact key; do not treat object-store 404 as authorization |
| Writes fail after a period of success | Full disk, inode exhaustion, or quota | Data volume **and** metadata volume; capacity alerts |
| Incomplete multipart upload remains | A large or interrupted put left parts behind | Abort the upload with the same identity if the API supports it; small smoke objects should not need multipart |

## Backups and versioning

Plan backup and recovery for object-store metadata and object bytes together
with the collaboration database. Restoring only one side can leave rows without
bytes, or bytes without authorized records.

Bucket versioning is optional and provider-specific. Enable it only if you
understand that product's restore and cost behavior. Versioning is not a
substitute for backup. Replication, erasure coding, and three-way copies are
availability controls; they do not prove you can restore from operator error,
bad encryption keys, or a destroyed cluster.

ContextDesk does not manage provider lifecycle policies, retention, legal hold
at the bucket, source migration, or automatic source cleanup in this milestone.

## What this is not

- There is **no shipped S3 evidence provider** at the commit this page was
  written against. Filesystem storage is the shipped provider.
- There is no local-filesystem-to-S3 migration tool.
- There is no retention, legal-hold, or lifecycle automation in the object
  store.
- There are no browser credentials and no direct or presigned browser uploads
  to the bucket.
- There is no multi-provider mirroring or failover.
- A successful smoke test is not automatic recovery proof.
- Garage (or any other product named here) is not a certified vendor.
- help://s3-backup remains the desktop Phase A workspace export. It does not
  store War Room evidence and still has no restore, remote deletion,
  bidirectional sync, or S3-backed index.

For local and shared War Room shapes, open help://war-room-deployment. For
how evidence is reviewed after it is stored, open
help://war-room-evidence-review.
