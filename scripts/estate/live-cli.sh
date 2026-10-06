#!/usr/bin/env bash
# Runs the installed Claude Code CLI once, as the app's Claude Code provider
# runs it, under the lane fence: for recording a fixture under
# src/lib/__tests__/fixtures/claude-cli/ or live-proving a change to the CLI
# transport. See ESTATE.md, the Claude Code CLI entries.
# Run: scripts/estate/live-cli.sh <stdin.jsonl> <output>
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: live-cli.sh <stdin.jsonl> <output>" >&2; exit 2; }
[ -f "$1" ] || { echo "live-cli.sh: no stdin file $1" >&2; exit 1; }

# Resolved before the cd into the scratch folder below. The output's folder
# is made here, so the caller needs no mkdir of its own.
mkdir -p "$(dirname "$2")"
stdin_file="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
output="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"

# The lane fence as the lane launchers register it, so the nested session is
# bound by the fence that binds its caller (Agent-Harness-Reconfig,
# ops/hooks/lane-fence.py). With --tools "" it never fires.
fence='{"hooks":{"PreToolUse":[{"matcher":"Bash|Write|Edit|NotebookEdit","hooks":[{"type":"command","command":"python3 /Users/johnp/Code/Agent-Harness-Reconfig/ops/hooks/lane-fence.py"}]}]}}'

# The arguments build_claude_cli_args("claude-opus-5-5", true) builds
# (src-tauri/src/commands/claude_cli.rs), --mcp-config last as there.
app_args=(
  -p --output-format stream-json --input-format stream-json --verbose
  --setting-sources project --disable-slash-commands --tools "" --no-session-persistence
  --prompt-suggestions false --model claude-opus-5-5
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
)

# As the app does, unless the caller names a config folder.
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# The app runs claude in the wiki's folder; a scratch folder stands in for it.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
echo "live-cli.sh: $(claude --version), CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" >&2

cd "$scratch"
status=0
claude --settings "$fence" "${app_args[@]}" < "$stdin_file" > "$output" || status=$?
echo "live-cli.sh: exit $status, output in $output" >&2
exit "$status"
