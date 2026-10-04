#!/usr/bin/env bash
# Phase A proof for pearson-tfl/llm_wiki#3. Copies a vault's raw/, wiki/ and
# the .llm-wiki stores the rename reads, runs `apply` on the copy, then runs
# the app's own startup comparison (Rust) and change processing (TypeScript)
# on an untouched copy and on the renamed copy, and summarises both.
# Reads VAULT only; every write is under the scratch folder.
#
#   prove-on-copy.sh VAULT
set -euo pipefail

VAULT=${1:?usage: prove-on-copy.sh VAULT}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
SCRATCH=${EXT_RENAME_SCRATCH:-/tmp/llmw-3-ext-rename}
RUN="$SCRATCH/run-$(date +%Y%m%dT%H%M%S)"
CRATE="$SCRATCH/crate"
APP_STATE="$HOME/Library/Application Support/com.llmwiki.app/app-state.json"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$SCRATCH/cargo-target"

mkdir -p "$RUN/vault/.llm-wiki"
cp -R "$VAULT/raw" "$VAULT/wiki" "$RUN/vault/"
for store in file-snapshot.json review.json ingest-cache.json project.json; do
  cp "$VAULT/.llm-wiki/$store" "$RUN/vault/.llm-wiki/"
done
cp -R "$RUN/vault" "$RUN/baseline"

PROJECT_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$RUN/vault/.llm-wiki/project.json")
# Only this project's watch settings leave app-state.json, which also holds keys.
WATCH_CONFIG=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["sourceWatchConfig"][sys.argv[2]]))' "$APP_STATE" "$PROJECT_ID")
export EXT_RENAME_PROJECT_ID="$PROJECT_ID" EXT_RENAME_WATCH_CONFIG="$WATCH_CONFIG"

python3 "$HERE/rename_ext_sources.py" check "$RUN/vault" --full > "$RUN/check-before.json"
python3 "$HERE/rename_ext_sources.py" apply "$RUN/vault" > "$RUN/apply.json"
python3 "$HERE/rename_ext_sources.py" check "$RUN/vault" --full > "$RUN/check-after-apply.json"
cp -R "$RUN/vault/.llm-wiki" "$RUN/stores-after-apply"
# Control: the same rename with the snapshot left as it was, to show the
# harness sees the deletes the snapshot edit prevents.
cp -R "$RUN/baseline" "$RUN/control"
python3 "$HERE/rename_ext_sources.py" apply "$RUN/control" > /dev/null
cp "$RUN/baseline/.llm-wiki/file-snapshot.json" "$RUN/control/.llm-wiki/"

# A scratch copy of the app's crate, with the harness test appended.
mkdir -p "$CRATE/dist" "$CRATE/mcp-server/dist" "$CRATE/mcp-server/node_modules"
rsync -a --delete --exclude target "$REPO/src-tauri/" "$CRATE/src-tauri/"
cat "$HERE/harness/startup_rescan.rs" >> "$CRATE/src-tauri/src/commands/file_sync.rs"
cp "$REPO/mcp-server/package.json" "$CRATE/mcp-server/"
mkdir -p "$CRATE/src/lib"
cp "$REPO/src/lib/source-watch-defaults.json" "$CRATE/src/lib/"
echo '<!doctype html>' > "$CRATE/dist/index.html"
touch "$CRATE/mcp-server/dist/placeholder.js" "$CRATE/mcp-server/node_modules/.placeholder"

for side in baseline vault control; do
  EXT_RENAME_VAULT="$RUN/$side" EXT_RENAME_TASKS_OUT="$RUN/tasks-$side.json" \
    cargo test --quiet --manifest-path "$CRATE/src-tauri/Cargo.toml" --lib \
    ext_rename_harness -- --ignored > "$RUN/cargo-$side.log" 2>&1
  (cd "$REPO" && EXT_RENAME_VAULT="$RUN/$side" EXT_RENAME_TASKS="$RUN/tasks-$side.json" \
    EXT_RENAME_REPORT="$RUN/processing-$side.json" \
    npx vitest run scripts/estate/ext-rename/harness/startup-processing.harness.test.ts \
    > "$RUN/vitest-$side.log" 2>&1)
done

python3 "$HERE/rename_ext_sources.py" check "$RUN/vault" --full > "$RUN/check-after-app.json"
python3 "$HERE/harness/summarise.py" "$RUN" | tee "$RUN/summary.txt"
