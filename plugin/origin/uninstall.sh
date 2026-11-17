#!/bin/bash
# Removes what setup.sh made. Run this script on the computer that has your
# terminal (the origin).
#
#   origin/uninstall.sh <ssh host>   removes the setup of one remote host:
#                                    the mod, the key, the "paste-origin" host
#                                    and the permission rule on the remote
#                                    host, and the block and the key of that
#                                    host on this computer
#   origin/uninstall.sh --local      stops the origin server and removes
#                                    ~/.claude-paste-file and each block from
#                                    ~/.ssh/config on this computer. Do this
#                                    after you removed each remote host.
#
# The script does not remove the mod from this computer. To do that, run:
#   claude plugin uninstall paste-file@paste-file
#   plugin/allow-read.sh --remove
set -euo pipefail

usage() {
  echo "Usage: uninstall.sh <ssh host> | --local"
}
here=$(cd "$(dirname "$0")" && pwd)
dir=$HOME/.claude-paste-file

case ${1:-} in
  -h | --help)
    usage
    exit 0
    ;;
  '')
    usage >&2
    exit 2
    ;;
  --local)
    if [ -x "$dir/bin/origind" ]; then "$dir/bin/origind" stop; fi
    if [ -f "$HOME/.ssh/config" ]; then
      markers=$(grep '^# claude-paste-file: ' "$HOME/.ssh/config" || true)
      while IFS= read -r marker; do
        [ -n "$marker" ] && "$here/ssh-block.sh" "$HOME/.ssh/config" "$marker" </dev/null
      done <<< "$markers"
    fi
    rm -rf "$dir"
    echo "Removed the origin server, $dir and the blocks in ~/.ssh/config."
    exit 0
    ;;
  -*)
    usage >&2
    exit 2
    ;;
esac

host=$1
pattern=${host#*@}

echo "1. Remote host $host"
pub=$(ssh "$host" 'cat ~/.ssh/claude_paste_file_ed25519.pub 2>/dev/null' || true)
ssh "$host" bash -s <<'REMOTE'
set -u
if command -v claude >/dev/null; then
  claude plugin uninstall paste-file@paste-file >/dev/null 2>&1 </dev/null
  claude plugin marketplace remove paste-file >/dev/null 2>&1 </dev/null
fi
if [ -f ~/claude-paste-file/plugin/allow-read.sh ]; then
  bash ~/claude-paste-file/plugin/allow-read.sh --remove </dev/null
fi
if [ -f ~/claude-paste-file/plugin/origin/ssh-block.sh ] && [ -f ~/.ssh/config ]; then
  bash ~/claude-paste-file/plugin/origin/ssh-block.sh ~/.ssh/config '# claude-paste-file: the connection back to the computer that has your terminal' </dev/null
fi
rm -f ~/.ssh/claude_paste_file_ed25519 ~/.ssh/claude_paste_file_ed25519.pub ~/.ssh/claude_paste_file_known_hosts
# A clone of the repository stays. The folder that setup.sh made has no .git.
if [ -d ~/claude-paste-file ] && [ ! -e ~/claude-paste-file/.git ]; then
  rm -rf ~/claude-paste-file
fi
REMOTE

echo "2. This computer"
if [ -f "$HOME/.ssh/config" ]; then
  "$here/ssh-block.sh" "$HOME/.ssh/config" "# claude-paste-file: $pattern" </dev/null
fi
keydata=$(printf '%s\n' "$pub" | awk '{print $2}')
if [ -n "$keydata" ] && [ -f "$dir/authorized_keys" ]; then
  kept=$(grep -vF "$keydata" "$dir/authorized_keys" || true)
  printf '%s' "${kept:+$kept
}" > "$dir/authorized_keys"
fi
echo "Removed the setup of $host."
