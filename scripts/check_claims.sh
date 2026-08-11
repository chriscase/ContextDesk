#!/usr/bin/env sh
# Fail closed if the claims table shape changes, a row is malformed, or any
# Shipped anchor no longer resolves to source.  This intentionally rejects
# escaped pipes in the table: a literal pipe changes the markdown column shape
# and must be rewritten (for example, as "list/detail") before it can be
# machine-checked.
# No network, no cargo, no secrets.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
CLAIMS=${CLAIMS_FILE:-"$ROOT/docs/CLAIMS.md"}
EXPECTED_ROWS=89
EXPECTED_SHIPPED_ROWS=85
EXPECTED_ROADMAP_ROWS=4
fail=0

if [ ! -f "$CLAIMS" ]; then
  echo "error: missing $CLAIMS" >&2
  exit 1
fi

ROWS_FILE=$(mktemp "${TMPDIR:-/tmp}/contextdesk-claims.XXXXXX")
trap 'rm -f "$ROWS_FILE"' EXIT HUP INT TERM

# Parse exactly four-column markdown rows.  A plain field split silently
# reclassifies a row containing an escaped or unescaped pipe, so reject those
# rows before they can hide a missing anchor.  The output is normalized for the
# source-anchor loop below: status<TAB>anchor<TAB>name<TAB>line number.
if ! awk -v expected_rows="$EXPECTED_ROWS" \
  -v expected_shipped="$EXPECTED_SHIPPED_ROWS" \
  -v expected_roadmap="$EXPECTED_ROADMAP_ROWS" '
function trim(value) {
  gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
  return value
}
function fail_row(message) {
  printf "FAIL: CLAIMS.md:%d — %s\n", NR, message > "/dev/stderr"
  malformed = 1
}
function clear_fields(    j) {
  for (j in fields)
    delete fields[j]
}

/^[[:space:]]*$/ { next }

{
  line = $0
  if (line !~ /^\|/)
    next

  # Header and separator are structural rows, not claims.
  if (line ~ /^\|[[:space:]]*Capability[[:space:]]*\|[[:space:]]*Status[[:space:]]*\|[[:space:]]*Code anchor \(path:symbol\)[[:space:]]*\|[[:space:]]*Doc references[[:space:]]*\|[[:space:]]*$/) {
    header_rows++
    next
  }
  if (line ~ /^\|[-:|[:space:]]+\|$/) {
    separator_rows++
    next
  }

  if (line ~ /\\/) {
    fail_row("backslash/escaped-pipe in a claims row; rewrite the cell without a pipe")
    next
  }
  if (substr(line, length(line), 1) != "|") {
    fail_row("row must end with a pipe")
    next
  }

  # Split on the four unescaped separators.  The leading pipe produces empty
  # field 1 and the trailing pipe terminates field 5; a valid row therefore
  # has n == 5.
  n = 0
  field = ""
  for (i = 1; i <= length(line); i++) {
    ch = substr(line, i, 1)
    if (ch == "|") {
      fields[++n] = trim(field)
      field = ""
    } else {
      field = field ch
    }
  }
  if (n != 5 || fields[1] != "") {
    fail_row("expected exactly four columns (unescaped pipes only)")
    clear_fields()
    next
  }

  name = fields[2]
  status = fields[3]
  anchor = fields[4]
  if (name == "" || status == "" || anchor == "") {
    fail_row("name, status, and code anchor are required")
    clear_fields()
    next
  }
  if (status != "Shipped" && status != "Roadmap") {
    fail_row("status must be Shipped or Roadmap")
    clear_fields()
    next
  }
  rows++
  if (status == "Shipped") shipped++
  if (status == "Roadmap") roadmap++
  printf "%s\t%s\t%s\t%d\n", status, anchor, name, NR
  clear_fields()
}

END {
  if (header_rows != 1)
    printf "FAIL: CLAIMS.md — expected exactly one table header (found %d)\n", header_rows > "/dev/stderr"
  if (separator_rows != 1)
    printf "FAIL: CLAIMS.md — expected exactly one table separator (found %d)\n", separator_rows > "/dev/stderr"
  if (rows != expected_rows)
    printf "FAIL: CLAIMS.md — expected %d claim rows, found %d\n", expected_rows, rows > "/dev/stderr"
  if (shipped != expected_shipped)
    printf "FAIL: CLAIMS.md — expected %d Shipped rows, found %d\n", expected_shipped, shipped > "/dev/stderr"
  if (roadmap != expected_roadmap)
    printf "FAIL: CLAIMS.md — expected %d Roadmap rows, found %d\n", expected_roadmap, roadmap > "/dev/stderr"
  if (malformed || header_rows != 1 || separator_rows != 1 || rows != expected_rows || shipped != expected_shipped || roadmap != expected_roadmap)
    exit 1
}
' "$CLAIMS" > "$ROWS_FILE"; then
  echo "check_claims: FAILED" >&2
  exit 1
fi

while IFS="$(printf '\t')" read -r status anchor name line_no; do
  if [ -z "$anchor" ]; then
    echo "FAIL: CLAIMS.md:$line_no — $status row missing anchor: $name"
    fail=1
    continue
  fi
  if [ "$status" != "Shipped" ]; then
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
done < "$ROWS_FILE"

if [ "$fail" -ne 0 ]; then
  echo "check_claims: FAILED" >&2
  exit 1
fi
if [ "${CHECK_CLAIMS_SKIP_AUX:-0}" != "1" ]; then
  node "$ROOT/scripts/check_design_handbook.mjs" "$ROOT"
  node "$ROOT/scripts/check_incident_evidence_drift.mjs"
  node "$ROOT/scripts/check_public_media.mjs" "$ROOT"
  node "$ROOT/scripts/check_help_corpus.mjs"
  node "$ROOT/scripts/check_packaged_demo_manifest.mjs" "$ROOT"
fi
echo "check_claims: OK"
exit 0
