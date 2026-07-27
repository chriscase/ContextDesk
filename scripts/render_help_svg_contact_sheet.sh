#!/bin/sh
# Render every bundled Help SVG at three reader widths for explicit review.
# This is an authoring/release artifact, not a default-test dependency.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 OUTPUT_DIRECTORY" >&2
  exit 2
fi

for tool in rsvg-convert magick; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required to render the Help SVG contact sheet" >&2
    exit 2
  fi
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
output_dir=$1
mkdir -p "$output_dir"
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/contextdesk-help-svg.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

manifest="$output_dir/help-svg-contact-sheet.txt"
: >"$manifest"
set --
for svg in "$repo_root"/docs/help/assets/*.svg; do
  base=$(basename "$svg" .svg)
  for entry in narrow:380 normal:760 zoom-200:1520; do
    name=${entry%%:*}
    width=${entry##*:}
    rendered="$work_dir/$base-$name.png"
    rsvg-convert --keep-aspect-ratio --width "$width" "$svg" --output "$rendered"
    printf '%s\t%s\t%s\n' "$base" "$name" "$width" >>"$manifest"
    set -- "$@" "$rendered"
  done
done

magick montage "$@" \
  -background '#0b0c0e' \
  -fill '#e5e7eb' \
  -stroke none \
  -label '%t' \
  -tile 3x \
  -geometry '520x260+14+28' \
  "$output_dir/help-svg-contact-sheet.png"

echo "Rendered $output_dir/help-svg-contact-sheet.png"
echo "Order/width manifest: $manifest"
