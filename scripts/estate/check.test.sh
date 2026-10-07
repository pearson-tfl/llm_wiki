#!/usr/bin/env bash
# Tests for check.sh. Each case runs a copy of the script inside a throwaway
# git repository in its own temp folder, with stub tools on a bare PATH, so
# no real npm, cargo or checkout is touched. Run: scripts/estate/check.test.sh
set -u

here="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

# A fresh repository holding check.sh, one commit, a src-tauri folder, and a
# stub bin folder with every tool named in "$@". The stubs log their
# arguments and the folder they ran in to calls.log, and fail when their
# command line equals $FAIL_ON.
setup() {
  case_dir="$scratch/$1"; shift
  repo="$case_dir/repo"
  stubs="$case_dir/stubs"
  mkdir -p "$repo/scripts/estate" "$repo/src-tauri" "$stubs" "$case_dir/home" "$case_dir/brew"
  cp "$here/check.sh" "$repo/scripts/estate/check.sh"
  git -C "$repo" init -q
  git -C "$repo" add -A
  git -C "$repo" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m script
  for tool in "$@"; do
    cat > "$stubs/$tool" <<EOF
#!/bin/sh
echo "$tool \$* in \$(basename "\$PWD")" >> "$case_dir/calls.log"
[ "$tool \$*" = "\${FAIL_ON:-}" ] && exit 1
exit 0
EOF
    chmod +x "$stubs/$tool"
  done
}

run() {
  env -i HOME="$case_dir/home" HOMEBREW_PREFIX="$case_dir/brew" FAIL_ON="${1:-}" \
    PATH="$stubs:/usr/bin:/bin" bash "$repo/scripts/estate/check.sh" \
    > "$case_dir/out.log" 2>&1
}

all_tools=(node cargo protoc npm)
steps=(
  "npm ci"
  "npm --prefix mcp-server ci"
  "npm run typecheck"
  "npm run test:mocks"
  "npm run mcp:build"
  "cargo test"
)

for missing in node cargo protoc; do
  present=()
  for tool in "${all_tools[@]}"; do [ "$tool" = "$missing" ] || present+=("$tool"); done
  setup "missing-$missing" "${present[@]}"
  if run; then fail "missing $missing: exited 0"; fi
  grep -q "$missing" "$case_dir/out.log" || fail "missing $missing: output does not name it"
  if [ -e "$case_dir/calls.log" ] && grep -q '^npm' "$case_dir/calls.log"; then
    fail "missing $missing: npm ran before the check failed"
  fi
done

# Every step runs, in order: npm from the checkout's root, cargo from
# src-tauri.
setup ok "${all_tools[@]}"
run || fail "ok: exited non-zero: $(cat "$case_dir/out.log")"
expected_calls="npm ci in repo
npm --prefix mcp-server ci in repo
npm run typecheck in repo
npm run test:mocks in repo
npm run mcp:build in repo
cargo test in src-tauri"
[ "$(grep -E '^(npm|cargo) ' "$case_dir/calls.log")" = "$expected_calls" ] \
  || fail "ok: calls were: $(cat "$case_dir/calls.log")"
sha="$(git -C "$repo" describe --always --dirty --exclude '*')"
grep -q "$sha" "$case_dir/out.log" || fail "ok: output does not name commit $sha"

# Any one step failing fails the check, and nothing after it runs.
for i in "${!steps[@]}"; do
  step="${steps[$i]}"
  setup "fails-$i" "${all_tools[@]}"
  if run "$step"; then fail "$step fails: exited 0"; fi
  last="$(tail -n 1 "$case_dir/calls.log")"
  [ "$last" = "$step in repo" ] || [ "$last" = "$step in src-tauri" ] \
    || fail "$step fails: a later step ran: $(cat "$case_dir/calls.log")"
done

# The tools live only where check.sh adds them to PATH: cargo under
# $HOME/.cargo/bin, protoc under $HOMEBREW_PREFIX/bin.
setup path node npm cargo protoc
mkdir -p "$case_dir/home/.cargo/bin" "$case_dir/brew/bin"
mv "$stubs/cargo" "$case_dir/home/.cargo/bin/cargo"
mv "$stubs/protoc" "$case_dir/brew/bin/protoc"
run || fail "path: cargo and protoc not found where check.sh puts them on PATH: $(cat "$case_dir/out.log")"

# A node under $HOMEBREW_PREFIX/bin does not displace the caller's node.
setup node-order "${all_tools[@]}"
mkdir -p "$case_dir/brew/bin"
printf '#!/bin/sh\necho "brew-node $*" >> "%s/calls.log"\n' "$case_dir" > "$case_dir/brew/bin/node"
chmod +x "$case_dir/brew/bin/node"
printf '#!/bin/sh\nnode\necho "npm $*" >> "%s/calls.log"\n' "$case_dir" > "$stubs/npm"
run || fail "node-order: exited non-zero: $(cat "$case_dir/out.log")"
grep -q '^brew-node' "$case_dir/calls.log" && fail "node-order: Homebrew's node ran ahead of the caller's"
grep -q '^node' "$case_dir/calls.log" || fail "node-order: the caller's node did not run"

if [ "$failures" -eq 0 ]; then echo "check.test.sh: all passed"; else exit 1; fi
