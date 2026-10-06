#!/usr/bin/env bash
# Builds the installed app from the checkout this script lives in. The only
# way to build it: see ESTATE.md, Build. Run: scripts/estate/build.sh
set -euo pipefail

# Rust and protoc are not on the agent PATH.
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:${HOMEBREW_PREFIX:-/opt/homebrew}/bin:$PATH"

for tool in node cargo protoc; do
  command -v "$tool" > /dev/null || { echo "build.sh: $tool not found on PATH" >&2; exit 1; }
done

cd "$(dirname "$0")/../.."
npm ci
npx tauri build --bundles app

bundle="$PWD/src-tauri/target/release/bundle/macos/LLM Wiki.app"
[ -d "$bundle" ] || { echo "build.sh: no bundle at $bundle" >&2; exit 1; }
# The same value the Settings > About stamp shows (vite.config.ts).
echo "Built estate $(git describe --always --dirty --exclude '*')"
echo "Bundle: $bundle"
