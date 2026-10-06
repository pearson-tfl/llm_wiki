#!/usr/bin/env bash
# Tests for build.sh. Each case runs a copy of the script inside a throwaway
# git repository in its own temp folder, with stub tools on a bare PATH, so
# no real npm, cargo or checkout is touched. Run: scripts/estate/build.test.sh
set -u

here="$(cd "$(dirname "$0")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

# A fresh repository holding build.sh, one commit, and a stub bin folder with
# every tool named in "$@". The stubs log their arguments to calls.log; npx
# also makes the bundle, as tauri does.
setup() {
  case_dir="$scratch/$1"; shift
  repo="$case_dir/repo"
  stubs="$case_dir/stubs"
  mkdir -p "$repo/scripts/estate" "$stubs" "$case_dir/home" "$case_dir/brew"
  cp "$here/build.sh" "$repo/scripts/estate/build.sh"
  git -C "$repo" init -q
  git -C "$repo" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --allow-empty -m init
  git -C "$repo" add -A
  git -C "$repo" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m script
  for tool in "$@"; do
    cat > "$stubs/$tool" <<EOF
#!/bin/sh
echo "$tool \$*" >> "$case_dir/calls.log"
if [ "$tool" = npx ]; then mkdir -p "src-tauri/target/release/bundle/macos/LLM Wiki.app"; fi
EOF
    chmod +x "$stubs/$tool"
  done
}

run() {
  env -i HOME="$case_dir/home" HOMEBREW_PREFIX="$case_dir/brew" \
    PATH="$stubs:/usr/bin:/bin" bash "$repo/scripts/estate/build.sh" \
    > "$case_dir/out.log" 2>&1
}

all_tools=(node cargo protoc npm npx)

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

setup ok "${all_tools[@]}"
run || fail "ok: exited non-zero: $(cat "$case_dir/out.log")"
expected_calls="npm ci
npx tauri build --bundles app"
[ "$(grep -E '^(npm|npx) ' "$case_dir/calls.log")" = "$expected_calls" ] \
  || fail "ok: calls were: $(cat "$case_dir/calls.log")"
sha="$(git -C "$repo" describe --always --dirty --exclude '*')"
grep -q "$sha" "$case_dir/out.log" || fail "ok: output does not name commit $sha"
grep -qF "$repo/src-tauri/target/release/bundle/macos/LLM Wiki.app" "$case_dir/out.log" \
  || fail "ok: output does not name the bundle path"

# The tools live only where build.sh adds them to PATH: cargo under
# $HOME/.cargo/bin, protoc under $HOMEBREW_PREFIX/bin.
setup path node npm npx cargo protoc
mkdir -p "$case_dir/home/.cargo/bin" "$case_dir/brew/bin"
mv "$stubs/cargo" "$case_dir/home/.cargo/bin/cargo"
mv "$stubs/protoc" "$case_dir/brew/bin/protoc"
run || fail "path: cargo and protoc not found where build.sh puts them on PATH: $(cat "$case_dir/out.log")"

# A failed npm ci stops the build before tauri runs.
setup npm-fails "${all_tools[@]}"
printf '#!/bin/sh\necho "npm $*" >> "%s/calls.log"\nexit 1\n' "$case_dir" > "$stubs/npm"
if run; then fail "npm-fails: exited 0"; fi
grep -q '^npx' "$case_dir/calls.log" && fail "npm-fails: tauri ran after npm ci failed"

# No bundle after tauri: the script fails rather than print a path that does
# not exist.
setup no-bundle "${all_tools[@]}"
printf '#!/bin/sh\necho "npx $*" >> "%s/calls.log"\n' "$case_dir" > "$stubs/npx"
if run; then fail "no-bundle: exited 0"; fi

# A dirty tree prints the -dirty commit, as the Settings > About stamp does.
setup dirty "${all_tools[@]}"
echo edit >> "$repo/scripts/estate/build.sh.note"
git -C "$repo" add -A
run || fail "dirty: exited non-zero"
grep -q -- '-dirty' "$case_dir/out.log" || fail "dirty: output does not say -dirty"

if [ "$failures" -eq 0 ]; then echo "build.test.sh: all passed"; else exit 1; fi
