#!/bin/bash
# claude-paste-file setup for SSH. Run this script on the computer that has your
# terminal (the origin), one time for each remote host:
#
#   origin/setup.sh <ssh host>
#
# The script needs no administrator rights. It does these steps:
#   1. Starts the origin server of your own user on 127.0.0.1 (see origind).
#   2. Makes a key on the remote host (~/.ssh/claude_paste_file_ed25519).
#   3. Adds that key to ~/.claude-paste-file/authorized_keys on this computer. The
#      key can read files and the clipboard image. It gives no shell.
#   4. Adds the host "paste-origin" to ~/.ssh/config on the remote host.
#   5. Adds a block for the remote host to ~/.ssh/config on this computer.
#      Each connection then starts the origin server and opens the way back.
#   6. Copies the mod to ~/claude-paste-file/plugin on the remote host,
#      installs it there for your user, and adds the permission rule for the
#      paste folder (see allow-read.sh).
#   7. Tests the connection from the remote host back to this computer.
set -euo pipefail

host=${1:?Usage: setup.sh <ssh host>}
remote_port=${CLAUDE_PASTE_FILE_REMOTE_PORT:-47822}
local_port=${CLAUDE_PASTE_FILE_LOCAL_PORT:-47823}
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
dir=${CLAUDE_PASTE_FILE_HOME:-$HOME/.claude-paste-file}
pattern=${host#*@}
chmod +x "$here/serve.sh" "$here/origind"

echo "1. Origin server on this computer (127.0.0.1:$local_port)"
"$here/origind" start "$local_port"

echo "2. Key on $host"
pub=$(ssh "$host" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && { [ -f ~/.ssh/claude_paste_file_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C claude-paste-file -f ~/.ssh/claude_paste_file_ed25519; } && cat ~/.ssh/claude_paste_file_ed25519.pub')
keydata=$(printf '%s\n' "$pub" | awk '{print $2}')
[ -n "$keydata" ] || { echo "The remote host gave no key." >&2; exit 1; }

echo "3. $dir/authorized_keys on this computer"
grep -qF "$keydata" "$dir/authorized_keys" || printf 'restrict %s\n' "$pub" >> "$dir/authorized_keys"

echo "4. Host paste-origin on $host"
ssh "$host" "grep -q '^Host paste-origin\$' ~/.ssh/config 2>/dev/null || { cat >> ~/.ssh/config && chmod 600 ~/.ssh/config; }" <<EOF

# claude-paste-file: the connection back to the computer that has your terminal
Host paste-origin
  HostName 127.0.0.1
  Port $remote_port
  User $(id -un)
  IdentityFile ~/.ssh/claude_paste_file_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/claude_paste_file_known_hosts
EOF

echo "5. Block for $pattern in ~/.ssh/config on this computer"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/config && chmod 600 ~/.ssh/config
if ! grep -qF "# claude-paste-file: $pattern" ~/.ssh/config; then
  printf '\n# claude-paste-file: %s\nHost %s\n  RemoteForward 127.0.0.1:%s 127.0.0.1:%s\n  PermitLocalCommand yes\n  LocalCommand "%s" start %s\n' \
    "$pattern" "$pattern" "$remote_port" "$local_port" "$here/origind" "$local_port" >> ~/.ssh/config
fi

echo "6. Mod on $host (~/claude-paste-file/plugin)"
ssh "$host" 'mkdir -p ~/claude-paste-file/plugin ~/claude-paste-file/.claude-plugin'
scp -qr "$plugin/.claude-plugin" "$plugin/hooks" "$plugin/allow-read.sh" "$host:claude-paste-file/plugin/"
scp -q "$(dirname "$plugin")/.claude-plugin/marketplace.json" "$host:claude-paste-file/.claude-plugin/"
# Claude Code on the remote host reads the paste folder without a question.
ssh "$host" 'bash ~/claude-paste-file/plugin/allow-read.sh' || echo "The permission rule was not added on $host. Run there: ~/claude-paste-file/plugin/allow-read.sh" >&2
# The mod loads in each session of the user on the remote host.
if ssh "$host" 'command -v claude >/dev/null'; then
  ssh "$host" 'claude plugin marketplace add ~/claude-paste-file >/dev/null 2>&1; claude plugin install paste-file@paste-file --scope user >/dev/null 2>&1; claude plugin list | grep -q "paste-file@paste-file"' \
    || echo "The install on $host failed. Run there: claude plugin install paste-file@paste-file --marketplace ~/claude-paste-file" >&2
else
  echo "Claude Code is not in the PATH on $host. Run there: claude plugin install paste-file@paste-file --marketplace ~/claude-paste-file" >&2
fi

echo "7. Test"
if answer=$(ssh "$host" 'ssh -o BatchMode=yes -o ConnectTimeout=5 paste-origin "stat %2F"') && [ "$answer" = dir ]; then
  echo "The connection back to this computer operates."
  echo "The mod loads in each new Claude Code session on $host."
else
  echo "The connection back to this computer does not operate." >&2
  echo "Close all open connections to $host, because an open connection can hold port $remote_port, then run this script again." >&2
  exit 1
fi
