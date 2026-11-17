#!/bin/bash
# claude-paste-file origin: answers the requests of the paste-file mod.
#
# This script runs on the computer that has your terminal. The origin server
# (see origind) runs it as the forced command of each connection, so a
# connection can do these things only:
#   ping             prints the name and the version of the protocol
#   stat <path>      prints "dir", "file <bytes>", "missing" or "refused"
#   get <path>       writes the content of the file
#   clipboard        writes the clipboard image as a PNG (macOS)
#   clipboard-files  prints the path of each file on the clipboard (macOS)
# stat and get refuse a file that is not in a folder of the allow list,
# ~/.claude-paste-file/allowed_dirs.
# The path is percent-encoded.
set -u

dir=${1:-${CLAUDE_PASTE_FILE_HOME:-$HOME/.claude-paste-file}}
request=${SSH_ORIGINAL_COMMAND:-}
verb=${request%% *}
encoded=""
[ "$request" != "$verb" ] && encoded=${request#* }

case $encoded in
  *[!A-Za-z0-9%._~-]* | *%00*)
    echo "claude-paste-file: the path is not percent-encoded" >&2
    exit 2
    ;;
esac
path=$(printf '%b' "${encoded//%/\\x}")

# Prints the real path of a file or a folder that exists.
real_path() {
  local found
  if command -v realpath >/dev/null 2>&1; then
    found=$(realpath "$1" 2>/dev/null) || return 1
  else
    found=$(perl -MCwd=realpath -e 'my $r = realpath($ARGV[0]); defined $r or exit 1; print $r' "$1" 2>/dev/null) || return 1
  fi
  [ -e "$found" ] && printf '%s\n' "$found"
}

# Sets 'real' to the real path of the file. Returns 0 only when that path is
# in a folder of the allow list. A symbolic link that goes out of those
# folders is refused, because the real path is used.
allowed() {
  local line
  real=$(real_path "$1") || return 1
  [ -f "$dir/allowed_dirs" ] || return 1
  while IFS= read -r line; do
    case $line in '' | '#'*) continue ;; esac
    case $real in "${line%/}"/*) return 0 ;; esac
  done < "$dir/allowed_dirs"
  return 1
}

# Asks the clipboard agent for the clipboard, because this connection cannot
# read it (see origind). '$1' is 'png' for the image or 'files' for the paths
# of the files. The answer is in the file '$out'.
ask_agent() {
  local pipe=$dir/clip.req writer n=0
  if ! { [ -p "$pipe" ] && [ -f "$dir/agent.pid" ] && kill -0 "$(cat "$dir/agent.pid")" 2>/dev/null; }; then
    echo "claude-paste-file: the clipboard agent does not run" >&2
    return 1
  fi
  out=$dir/clip-$$.$1
  trap 'rm -f "$out" "$out.status"' EXIT
  ( echo "$1 $out" > "$pipe" ) &
  writer=$!
  while [ ! -f "$out.status" ] && [ $n -lt 100 ]; do
    sleep 0.1
    n=$((n + 1))
  done
  kill "$writer" 2>/dev/null
  [ -f "$out.status" ] && [ "$(cat "$out.status")" = 0 ]
}

case $verb in
  ping)
    echo "claude-paste-file 1"
    ;;
  stat)
    if [ -d "$path" ]; then
      echo dir
    elif [ ! -f "$path" ] || [ ! -r "$path" ]; then
      echo missing
    elif allowed "$path"; then
      echo "file $(stat -L -c %s "$real" 2>/dev/null || stat -L -f %z "$real")"
    else
      echo refused
    fi
    ;;
  get)
    [ -f "$path" ] && allowed "$path" || exit 1
    exec cat -- "$real"
    ;;
  clipboard)
    ask_agent png || exit 1
    cat "$out"
    ;;
  clipboard-files)
    ask_agent files || exit 1
    cat "$out"
    ;;
  *)
    echo "claude-paste-file: unknown request" >&2
    exit 2
    ;;
esac
