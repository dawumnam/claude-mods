#!/bin/bash
# Tests for the shell programs of the origin. They do not use SSH or the
# clipboard. Run: bash plugin/tests/origin.test.sh
set -u

plugin=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/cpf-test.XXXXXX")
work=$(cd "$work" && pwd -P)
trap 'rm -rf "$work"' EXIT
failures=0

check() {
  if [ "$2" = "$3" ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    echo "     expected: $3"
    echo "     received: $2"
    failures=$((failures + 1))
  fi
}

# Percent-encodes each byte that is not a letter, a digit or . _ ~ -
encode() {
  local out="" i c s=$1
  local LC_ALL=C
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [A-Za-z0-9._~-]) out+=$c ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

# Runs serve.sh as the origin server does. Prints "<exit code>: <output>".
serve() {
  local output code
  output=$(SSH_ORIGINAL_COMMAND="$1" "$plugin/origin/serve.sh" "$work/home" 2>&1)
  code=$?
  echo "$code: $output"
}

# ----- serve.sh -----
mkdir -p "$work/home" "$work/ok" "$work/secret"
printf '# test\n%s\n' "$work/ok" > "$work/home/allowed_dirs"
printf 'fine\n' > "$work/ok/It's (1) \$x.txt"
printf 'secret\n' > "$work/secret/key.txt"
ln -s "$work/secret/key.txt" "$work/ok/link.txt"
ln -s "$work/secret" "$work/ok/dirlink"

odd=$(encode "$work/ok/It's (1) \$x.txt")
check "ping" "$(serve ping)" "0: claude-paste-file 1"
check "stat of a file in an allowed folder" "$(serve "stat $odd")" "0: file 5"
check "get of a file in an allowed folder" "$(serve "get $odd")" "0: fine"
check "stat of a folder" "$(serve "stat $(encode "$work/ok")")" "0: dir"
check "stat of a path that does not exist" "$(serve "stat $(encode "$work/ok/none")")" "0: missing"
check "stat of a file outside the allow list" "$(serve "stat $(encode "$work/secret/key.txt")")" "0: refused"
check "get of a file outside the allow list" "$(serve "get $(encode "$work/secret/key.txt")")" "1: "
check "get through a symbolic link that goes out" "$(serve "get $(encode "$work/ok/link.txt")")" "1: "
check "get through a folder link that goes out" "$(serve "get $(encode "$work/ok/dirlink/key.txt")")" "1: "
check "get with .. that goes out" "$(serve "get $(encode "$work/ok/../secret/key.txt")")" "1: "
check "a path that is not encoded" "$(serve "get /etc/passwd;id")" "2: claude-paste-file: the path is not percent-encoded"
check "a shell command" "$(serve "id")" "2: claude-paste-file: unknown request"
check "clipboard without the agent" "$(serve clipboard)" "1: claude-paste-file: the clipboard agent does not run"
rm "$work/home/allowed_dirs"
check "get without an allow list" "$(serve "get $odd")" "1: "

# ----- ssh-block.sh -----
config=$work/config
block() {
  "$plugin/origin/ssh-block.sh" "$config" "$1"
}
printf 'Host first\n  User a\n\nHost *\n  ServerAliveInterval 30\n' > "$config"
before=$(cat "$config")

printf 'Host one\n  Port 1\n' | block "# marker: one"
check "add a block" "$(cat "$config")" "$before

# marker: one
Host one
  Port 1"

printf 'Host two\n  Port 2\n  User b\n' | block "# marker: two"
printf 'Host one\n  Port 11\n' | block "# marker: one"
check "replace a block and keep the others" "$(cat "$config")" "$before

# marker: two
Host two
  Port 2
  User b

# marker: one
Host one
  Port 11"

printf 'Host one\n  Port 11\n' | block "# marker: one"
check "the same block again changes nothing" "$(grep -c '^# marker: one$' "$config")" "1"

block "# marker: two" </dev/null
block "# marker: one" </dev/null
check "remove the blocks" "$(cat "$config")" "$before"

block "# marker: none" </dev/null
check "remove a block that is not there" "$(cat "$config")" "$before"

rm "$config"
printf 'Host one\n  Port 1\n' | block "# marker: one"
check "a new file" "$(cat "$config")" "# marker: one
Host one
  Port 1"

ln -s "$config" "$work/link"
printf 'Host two\n  Port 2\n' | "$plugin/origin/ssh-block.sh" "$work/link" "# marker: two"
check "a symbolic link stays a link" "$([ -L "$work/link" ] && grep -c '^Host two$' "$config")" "1"

# ----- usage -----
"$plugin/origin/setup.sh" >/dev/null 2>&1
check "setup.sh without a host" "$?" "2"
"$plugin/origin/uninstall.sh" >/dev/null 2>&1
check "uninstall.sh without a host" "$?" "2"
"$plugin/allow-read.sh" --bad >/dev/null 2>&1
check "allow-read.sh with a bad option" "$?" "2"

echo
if [ "$failures" -eq 0 ]; then
  echo "All tests passed."
else
  echo "$failures test(s) failed."
  exit 1
fi
