#!/bin/bash
# Replaces or removes one marked block in an SSH config file.
#
#   ssh-block.sh <config file> <marker line> < <block text>
#
# A block is the marker line (a comment), then a "Host" line, then the
# indented lines after it. The script removes the block that has this marker.
# If the standard input has text, the script then adds the marker and that
# text at the end of the file. The other lines of the file do not change.
# The file keeps its inode, so a symbolic link to it continues to work.
set -euo pipefail

config=${1:?Usage: ssh-block.sh <config file> <marker line> < <block text>}
marker=${2:?Usage: ssh-block.sh <config file> <marker line> < <block text>}
block=$(cat)

mkdir -p "$(dirname "$config")"
[ -e "$config" ] || : > "$config"
tmp=$(mktemp "${TMPDIR:-/tmp}/ssh-block.XXXXXX")
trap 'rm -f "$tmp"' EXIT

# Blank lines are printed only before a line that stays, so the removal of a
# block does not leave blank lines behind, and the file has none at its end.
awk -v marker="$marker" '
  $0 == marker { skip = 1; host = 0; blanks = 0; next }
  skip && !host && /^Host[ \t]/ { host = 1; next }
  skip && host && /^[ \t]+[^ \t]/ { next }
  { skip = 0 }
  /^[ \t]*$/ { blanks++; next }
  { while (blanks > 0) { print ""; blanks-- } print }
' "$config" > "$tmp"

if [ -n "$block" ]; then
  [ -s "$tmp" ] && printf '\n' >> "$tmp"
  printf '%s\n%s\n' "$marker" "$block" >> "$tmp"
fi
cat "$tmp" > "$config"
chmod 600 "$config"
