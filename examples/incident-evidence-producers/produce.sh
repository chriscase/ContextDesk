#!/usr/bin/env bash
# Shell-oriented support collector sketch for Incident Evidence Bundle v1.
set -euo pipefail

ROOT="${1:-./incident-evidence-out}"
mkdir -p "$ROOT/logs"
printf '%s\n' '2024-01-15T12:00:00Z INFO synthetic from shell collector' >"$ROOT/logs/app.log"

# Portable SHA-256 (macOS shasum / Linux sha256sum)
if command -v shasum >/dev/null 2>&1; then
  DIGEST=$(shasum -a 256 "$ROOT/logs/app.log" | awk '{print $1}')
elif command -v sha256sum >/dev/null 2>&1; then
  DIGEST=$(sha256sum "$ROOT/logs/app.log" | awk '{print $1}')
else
  DIGEST=$(openssl dgst -sha256 "$ROOT/logs/app.log" | awk '{print $NF}')
fi
BYTES=$(wc -c <"$ROOT/logs/app.log" | tr -d ' ')

cat >"$ROOT/manifest.json" <<EOF
{
  "schemaId": "contextdesk.incident_evidence.v1",
  "minReaderVersion": 1,
  "bundleId": "example-shell-bundle",
  "createdAt": "2024-01-15T12:05:00Z",
  "producer": { "name": "example-shell-collector", "version": "0.1.0" },
  "privacy": {
    "redactionDeclared": true,
    "containsCredentials": false,
    "containsPii": false
  },
  "timeBasis": { "timezone": "UTC", "timezoneResolved": true },
  "components": [
    {
      "id": "log-app",
      "role": "log",
      "path": "logs/app.log",
      "mediaType": "text/plain",
      "bytes": $BYTES,
      "sha256": "$DIGEST",
      "sourceLabel": "app"
    }
  ]
}
EOF

echo "wrote $ROOT"
echo "validate with: cargo run -p cd-core --bin cd-validate-incident-evidence -- $ROOT"
