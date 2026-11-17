#!/bin/bash
# claude-paste-file setup for SSH. Run this script on the computer that has
# your terminal (the origin), one time for each remote host. You can run it
# again at any time: it updates the files and replaces its own settings.
#
#   origin/setup.sh <ssh host>
#
# The script needs no administrator rights. It does these steps:
#   1. Tests the SSH connection and selects the return port.
#   2. Copies the origin programs to ~/.claude-paste-file/bin on this
#      computer and starts the origin server on 127.0.0.1 (see origind).
#   3. Copies the mod to ~/claude-paste-file on the remote host.
#   4. Makes a key on the remote host (~/.ssh/claude_paste_file_ed25519) and
#      adds it to ~/.claude-paste-file/authorized_keys on this computer. The
#      key can read files and the clipboard. It gives no shell.
#   5. Writes the host "paste-origin" in ~/.ssh/config on the remote host.
#   6. Writes a block for the remote host in ~/.ssh/config on this computer.
#      Each connection then starts the origin server and opens the way back.
#   7. Installs the mod on the remote host for your user, and adds the
#      permission rule for the paste folder (see allow-read.sh).
#   8. Tests the connection from the remote host back to this computer.
#
# The return port is 47000 plus the last three digits of your user id on the
# remote host, so two accounts on one machine get different ports. The
# variable CLAUDE_PASTE_FILE_REMOTE_PORT sets a different port, and
# CLAUDE_PASTE_FILE_LOCAL_PORT sets the port of the origin server (47823).
set -euo pipefail

usage() {
  echo "Usage: setup.sh <ssh host>"
  echo "Run it on the computer that has your terminal. See the start of this file."
}
case ${1:-} in
  -h | --help) usage; exit 0 ;;
  '' | -*) usage >&2; exit 2 ;;
esac

host=$1
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
repo=$(dirname "$plugin")
dir=$HOME/.claude-paste-file
local_port=${CLAUDE_PASTE_FILE_LOCAL_PORT:-47823}
pattern=${host#*@}
remote_marker='# claude-paste-file: the connection back to the computer that has your terminal'

echo "1. Connection to $host"
remote_uid=$(ssh "$host" 'id -u') || { echo "No SSH connection to $host." >&2; exit 1; }
case $remote_uid in
  '' | *[!0-9]*) echo "$host gave an unexpected answer: $remote_uid" >&2; exit 1 ;;
esac
remote_port=${CLAUDE_PASTE_FILE_REMOTE_PORT:-$((47000 + remote_uid % 1000))}

echo "2. Origin server on this computer (127.0.0.1:$local_port)"
mkdir -p "$dir/bin" && chmod 700 "$dir"
cp "$here/origind" "$here/serve.sh" "$dir/bin/"
chmod +x "$dir/bin/origind" "$dir/bin/serve.sh"
"$dir/bin/origind" restart "$local_port"
sleep 1
"$dir/bin/origind" status >/dev/null || { echo "The origin server does not run. See $dir/sshd.log" >&2; exit 1; }

echo "3. Mod files on $host (~/claude-paste-file)"
ssh "$host" 'mkdir -p ~/claude-paste-file/plugin/origin ~/claude-paste-file/.claude-plugin'
scp -qr "$plugin/.claude-plugin" "$plugin/hooks" "$plugin/allow-read.sh" "$host:claude-paste-file/plugin/"
scp -q "$here/ssh-block.sh" "$host:claude-paste-file/plugin/origin/"
scp -q "$repo/.claude-plugin/marketplace.json" "$host:claude-paste-file/.claude-plugin/"

echo "4. Key on $host, accepted on this computer"
pub=$(ssh "$host" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && { [ -f ~/.ssh/claude_paste_file_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C claude-paste-file -f ~/.ssh/claude_paste_file_ed25519; } && cat ~/.ssh/claude_paste_file_ed25519.pub')
keydata=$(printf '%s\n' "$pub" | awk '{print $2}')
[ -n "$keydata" ] || { echo "The remote host gave no key." >&2; exit 1; }
grep -qF "$keydata" "$dir/authorized_keys" || printf 'restrict %s\n' "$pub" >> "$dir/authorized_keys"

echo "5. Host paste-origin in ~/.ssh/config on $host (return port $remote_port)"
# The variables in the block get their values on this computer.
# shellcheck disable=SC2087
ssh "$host" "bash ~/claude-paste-file/plugin/origin/ssh-block.sh ~/.ssh/config '$remote_marker'" <<EOF
Host paste-origin
  HostName 127.0.0.1
  Port $remote_port
  User $(id -un)
  IdentityFile ~/.ssh/claude_paste_file_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/claude_paste_file_known_hosts
EOF

echo "6. Block for $pattern in ~/.ssh/config on this computer"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
"$here/ssh-block.sh" "$HOME/.ssh/config" "# claude-paste-file: $pattern" <<EOF
Host $pattern
  RemoteForward 127.0.0.1:$remote_port 127.0.0.1:$local_port
  PermitLocalCommand yes
  LocalCommand "$dir/bin/origind" start $local_port
EOF

echo "7. Mod and permission rule on $host"
if ssh "$host" 'command -v claude >/dev/null'; then
  ssh "$host" 'claude plugin marketplace add ~/claude-paste-file >/dev/null 2>&1; claude plugin install paste-file@paste-file --scope user >/dev/null 2>&1; claude plugin list | grep -q "paste-file@paste-file"' \
    || echo "The install on $host failed. Run there: claude plugin install paste-file@paste-file --marketplace ~/claude-paste-file" >&2
else
  echo "Claude Code is not in the PATH on $host. Run there: claude plugin install paste-file@paste-file --marketplace ~/claude-paste-file" >&2
fi
ssh "$host" 'bash ~/claude-paste-file/plugin/allow-read.sh' \
  || echo "The permission rule was not added on $host. Run there: ~/claude-paste-file/plugin/allow-read.sh" >&2

echo "8. Test"
answer=$(ssh "$host" 'ssh -o BatchMode=yes -o ConnectTimeout=5 paste-origin ping' 2>/dev/null) || true
if [ "$answer" = "claude-paste-file 1" ]; then
  echo "The connection back to this computer operates."
  echo "The mod loads in each new Claude Code session on $host. In an open session, run /reload-plugins."
else
  echo "The connection back to this computer does not operate." >&2
  echo "Close all open connections to $host, because an old connection can hold a return port, then run this script again." >&2
  echo "If the problem stays, run: $dir/bin/origind status" >&2
  exit 1
fi
