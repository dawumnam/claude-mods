#!/bin/bash
# paste-here setup for SSH. Run this script on the computer that has your
# terminal (the origin), one time for each remote host:
#
#   origin/setup.sh <ssh host>
#
# The script needs no administrator rights. It does these steps:
#   1. Starts the origin server of your own user on 127.0.0.1 (see origind).
#   2. Makes a key on the remote host (~/.ssh/paste_here_ed25519).
#   3. Adds that key to ~/.paste-here/authorized_keys on this computer. The
#      key can read files and the clipboard image. It gives no shell.
#   4. Adds the host "paste-origin" to ~/.ssh/config on the remote host.
#   5. Adds a block for the remote host to ~/.ssh/config on this computer.
#      Each connection then starts the origin server and opens the way back.
#   6. Copies the mod to ~/claude-mods/paste-here on the remote host and
#      installs it there for your user.
#   7. Tests the connection from the remote host back to this computer.
set -euo pipefail

host=${1:?Usage: setup.sh <ssh host>}
remote_port=${PASTE_HERE_REMOTE_PORT:-47822}
local_port=${PASTE_HERE_LOCAL_PORT:-47823}
here=$(cd "$(dirname "$0")" && pwd)
plugin=$(dirname "$here")
dir=${PASTE_HERE_HOME:-$HOME/.paste-here}
pattern=${host#*@}
chmod +x "$here/serve.sh" "$here/origind"

echo "1. Origin server on this computer (127.0.0.1:$local_port)"
"$here/origind" start "$local_port"

echo "2. Key on $host"
pub=$(ssh "$host" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && { [ -f ~/.ssh/paste_here_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C paste-here -f ~/.ssh/paste_here_ed25519; } && cat ~/.ssh/paste_here_ed25519.pub')
keydata=$(printf '%s\n' "$pub" | awk '{print $2}')
[ -n "$keydata" ] || { echo "The remote host gave no key." >&2; exit 1; }

echo "3. $dir/authorized_keys on this computer"
grep -qF "$keydata" "$dir/authorized_keys" || printf 'restrict %s\n' "$pub" >> "$dir/authorized_keys"

echo "4. Host paste-origin on $host"
ssh "$host" "grep -q '^Host paste-origin\$' ~/.ssh/config 2>/dev/null || { cat >> ~/.ssh/config && chmod 600 ~/.ssh/config; }" <<EOF

# paste-here: the connection back to the computer that has your terminal
Host paste-origin
  HostName 127.0.0.1
  Port $remote_port
  User $(id -un)
  IdentityFile ~/.ssh/paste_here_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/paste_here_known_hosts
EOF

echo "5. Block for $pattern in ~/.ssh/config on this computer"
mkdir -p ~/.ssh && chmod 700 ~/.ssh
touch ~/.ssh/config && chmod 600 ~/.ssh/config
if ! grep -qF "# paste-here: $pattern" ~/.ssh/config; then
  printf '\n# paste-here: %s\nHost %s\n  RemoteForward 127.0.0.1:%s 127.0.0.1:%s\n  PermitLocalCommand yes\n  LocalCommand "%s" start %s\n' \
    "$pattern" "$pattern" "$remote_port" "$local_port" "$here/origind" "$local_port" >> ~/.ssh/config
fi

echo "6. Mod on $host (~/claude-mods/paste-here)"
ssh "$host" 'mkdir -p ~/claude-mods/paste-here ~/claude-mods/.claude-plugin'
scp -qr "$plugin/.claude-plugin" "$plugin/hooks" "$host:claude-mods/paste-here/"
scp -q "$(dirname "$plugin")/.claude-plugin/marketplace.json" "$host:claude-mods/.claude-plugin/"
# The mod loads in each session of the user on the remote host.
if ssh "$host" 'command -v claude >/dev/null'; then
  ssh "$host" 'claude plugin marketplace add ~/claude-mods >/dev/null 2>&1; claude plugin install paste-here@claude-mods --scope user >/dev/null 2>&1; claude plugin list | grep -q "paste-here@claude-mods"' \
    || echo "The install on $host failed. Run there: claude plugin install paste-here@claude-mods --marketplace ~/claude-mods" >&2
else
  echo "Claude Code is not in the PATH on $host. Run there: claude plugin install paste-here@claude-mods --marketplace ~/claude-mods" >&2
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
