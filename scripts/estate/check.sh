#!/usr/bin/env bash
# Runs every check on the checkout this script lives in, stopping at the
# first failure: the check each lane runs before its offer, and the one the
# Estate check workflow runs on each push to estate. See ESTATE.md, Build.
# Run: scripts/estate/check.sh
set -euo pipefail

# Rust and protoc are not on the agent PATH. Homebrew's folder goes last, so
# its node does not displace the caller's.
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH:${HOMEBREW_PREFIX:-/opt/homebrew}/bin"

# Every lane and trial on this Mac builds Rust in one shared folder: a
# per-tree src-tauri/target is about 12 GB, and they filled the disk (#99).
# A caller's CARGO_TARGET_DIR wins; the Estate check workflow sets its own.
shared_target=/Users/johnp/Code/llm_wiki-worktrees/.cargo-target
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$shared_target}"

for tool in node cargo protoc; do
  command -v "$tool" > /dev/null || { echo "check.sh: $tool not found on PATH" >&2; exit 1; }
done

cd "$(dirname "$0")/../.."
scripts/estate/change_list.py
npm ci
npm --prefix mcp-server ci
npm run typecheck
npm run lint
npm run test:mocks
npm run test:llm
npm run mcp:build
(cd src-tauri && cargo test)

echo "check.sh: all checks passed on estate $(git describe --always --dirty --exclude '*')"
