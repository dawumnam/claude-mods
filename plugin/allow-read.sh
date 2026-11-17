#!/bin/bash
# Adds a rule to ~/.claude/settings.json of this user, so that Claude Code
# reads the files in the paste folder without a question. Claude Code asks a
# question for each file that is not in the working directory, and the paste
# folder is not in the working directory.
#
# Run this script one time on each computer that runs Claude Code.
# origin/setup.sh runs it on the remote host.
set -euo pipefail

command -v python3 >/dev/null || { echo "python3 is necessary to change ~/.claude/settings.json." >&2; exit 1; }

# The same folder as in hooks/register.js.
dir="${TMPDIR:-/tmp}"
dir="${dir%/}/claude-paste-file-$(id -u)"
mkdir -p -m 700 "$dir"
real=$(cd "$dir" && pwd -P)

python3 - "$dir" "$real" <<'PY'
import json, os, sys

path = os.path.expanduser('~/.claude/settings.json')
try:
    with open(path) as f:
        settings = json.load(f)
except FileNotFoundError:
    settings = {}
allow = settings.setdefault('permissions', {}).setdefault('allow', [])
added = []
for folder in dict.fromkeys(sys.argv[1:]):
    rule = 'Read(/' + folder + '/**)'
    if rule not in allow:
        allow.append(rule)
        added.append(rule)
if added:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + '.tmp', 'w') as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(path + '.tmp', path)
    print('Added to ' + path + ': ' + ', '.join(added))
else:
    print('The rule is already in ' + path)
PY
