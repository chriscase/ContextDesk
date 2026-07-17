#!/usr/bin/env sh
# Fail if any CLAIMS.md row marked Shipped has a missing file or missing symbol.
# No network, no cargo, no secrets.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CLAIMS="$ROOT/docs/CLAIMS.md"
fail=0

if [ ! -f "$CLAIMS" ]; then
  echo "error: missing $CLAIMS" >&2
  exit 1
fi

# Parse markdown table rows: | name | Status | path:symbol | ...
# Skip header and separator.
while IFS= read -r line; do
  case "$line" in
    "|"*) ;;
    *) continue ;;
  esac
  # crude column split
  status=$(printf '%s\n' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$3); print $3}')
  anchor=$(printf '%s\n' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$4); print $4}')
  name=$(printf '%s\n' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')
  [ "$status" = "Status" ] && continue
  [ "$status" = "--------" ] && continue
  [ -z "$status" ] && continue
  if [ "$status" != "Shipped" ]; then
    continue
  fi
  if [ -z "$anchor" ] || [ "$anchor" = "Code anchor (path:symbol)" ]; then
    echo "FAIL: Shipped row missing anchor: $name"
    fail=1
    continue
  fi
  path=${anchor%%:*}
  symbol=${anchor#*:}
  if [ ! -f "$ROOT/$path" ]; then
    echo "FAIL: $name — file missing: $path"
    fail=1
    continue
  fi
  if [ -n "$symbol" ] && [ "$symbol" != "$path" ]; then
    if ! grep -q -- "$symbol" "$ROOT/$path"; then
      echo "FAIL: $name — symbol not found in $path: $symbol"
      fail=1
      continue
    fi
  fi
  echo "ok: $name ($anchor)"
done < "$CLAIMS"

if [ "$fail" -ne 0 ]; then
  echo "check_claims: FAILED" >&2
  exit 1
fi
echo "check_claims: OK"
exit 0
