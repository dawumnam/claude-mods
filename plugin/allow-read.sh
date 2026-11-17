#!/bin/bash
# Adds a rule to ~/.claude/settings.json of this user, so that Claude Code
# reads the files in the paste folder without a question. Claude Code asks a
# question for each file that is not in the working directory, and the paste
# folder is not in the working directory.
#
#   allow-read.sh            adds the rule
#   allow-read.sh --remove   removes the rule
#
# Run this script one time on each computer that runs Claude Code.
# origin/setup.sh runs it on the remote host.
set -euo pipefail

mode=add
case ${1:-} in
  '') ;;
  --remove) mode=remove ;;
  *) echo "Usage: allow-read.sh [--remove]" >&2; exit 2 ;;
esac

command -v python3 >/dev/null || { echo "python3 is necessary to change ~/.claude/settings.json." >&2; exit 1; }

# The same folder as in hooks/register.js.
dir="${TMPDIR:-/tmp}"
dir="${dir%/}/claude-paste-file-$(id -u)"
if [ "$mode" = add ]; then
  mkdir -p "$dir"
  chmod 700 "$dir"
  real=$(cd "$dir" && pwd -P)
else
  real=$( { cd "$dir" 2>/dev/null && pwd -P; } || echo "$dir")
fi

python3 - "$mode" "$dir" "$real" <<'PY'
import json, os, sys

mode = sys.argv[1]
rules = ['Read(/' + folder + '/**)' for folder in dict.fromkeys(sys.argv[2:])]
path = os.path.expanduser('~/.claude/settings.json')
try:
    with open(path) as f:
        settings = json.load(f)
except FileNotFoundError:
    settings = {}
except json.JSONDecodeError as error:
    sys.exit(path + ' is not valid JSON, so it stays as it is: ' + str(error))

allow = settings.setdefault('permissions', {}).setdefault('allow', [])
if mode == 'add':
    changed = [rule for rule in rules if rule not in allow]
    allow.extend(changed)
else:
    changed = [rule for rule in rules if rule in allow]
    for rule in changed:
        allow.remove(rule)
    # Remove the keys that this script made, if they are empty now.
    if not allow:
        del settings['permissions']['allow']
    if not settings['permissions']:
        del settings['permissions']

if not changed:
    print('No change is necessary in ' + path)
    sys.exit(0)
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path + '.tmp', 'w') as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write('\n')
os.replace(path + '.tmp', path)
print(('Added to ' if mode == 'add' else 'Removed from ') + path + ': ' + ', '.join(changed))
PY
