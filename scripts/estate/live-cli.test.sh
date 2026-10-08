#!/usr/bin/env bash
# Tests for live-cli.sh. Each case runs the script with a stub claude on PATH
# that records its arguments, folder, stdin and environment, so no real
# claude starts. The last case hands the recorded command to the real lane
# fence. Run: scripts/estate/live-cli.test.sh
set -u

here="$(cd "$(dirname "$0")" && pwd)"
fence=/Users/johnp/Code/Agent-Harness-Reconfig/ops/hooks/lane-fence.py
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

failures=0
fail() { echo "FAIL: $1"; failures=$((failures + 1)); }

# A case folder with a stub claude. The stub answers --version; otherwise it
# writes its arguments (NUL-separated), folder, stdin and two variables to
# the case folder, prints one line and exits with $STUB_EXIT.
setup() {
  case_dir="$scratch/$1"
  mkdir -p "$case_dir/stubs" "$case_dir/caller" "$case_dir/home"
  cat > "$case_dir/stubs/claude" <<EOF
#!/bin/sh
if [ "\$1" = --version ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
printf '%s\0' "\$@" > "$case_dir/argv"
pwd -P > "$case_dir/cwd"
cat > "$case_dir/stdin"
echo "\${CLAUDE_CONFIG_DIR-unset}" > "$case_dir/config-dir"
echo "\${AHR_LANE_WORKTREE-unset}" > "$case_dir/marker"
echo '{"type":"result","subtype":"success"}'
exit "\${STUB_EXIT:-0}"
EOF
  chmod +x "$case_dir/stubs/claude"
  printf '{"type":"user","message":{"role":"user","content":"a colour"}}\n' > "$case_dir/caller/in.stdin.jsonl"
}

# Runs live-cli.sh from the caller folder with relative paths, as a lane
# would from its worktree. Variables come first, as VAR=value, then the
# script's arguments; with none, in.stdin.jsonl out.jsonl.
run() {
  local vars=()
  while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do vars+=("$1"); shift; done
  [ $# -gt 0 ] || set -- in.stdin.jsonl out.jsonl
  (cd "$case_dir/caller" && env -i HOME="$case_dir/home" PATH="$case_dir/stubs:/usr/bin:/bin" \
    ${vars[@]+"${vars[@]}"} bash "$here/live-cli.sh" "$@" > "$case_dir/out.log" 2>&1)
}

# Wrong argument counts stop before claude runs.
setup usage
for args in "" "in.stdin.jsonl" "in.stdin.jsonl out.jsonl extra"; do
  if [ -z "$args" ]; then
    (cd "$case_dir/caller" && env -i PATH="$case_dir/stubs:/usr/bin:/bin" \
      bash "$here/live-cli.sh" > "$case_dir/out.log" 2>&1)
  else
    # shellcheck disable=SC2086 # the split is the point
    run $args
  fi
  [ $? -eq 2 ] || fail "usage '$args': did not exit 2"
  grep -q "usage: " "$case_dir/out.log" || fail "usage '$args': no usage line"
  [ -e "$case_dir/argv" ] && fail "usage '$args': claude ran"
done

# A missing stdin file is named, and claude does not run.
setup missing-stdin
rm "$case_dir/caller/in.stdin.jsonl"
if run; then fail "missing stdin: exited 0"; fi
grep -q "in.stdin.jsonl" "$case_dir/out.log" || fail "missing stdin: output does not name the file"
[ -e "$case_dir/argv" ] && fail "missing stdin: claude ran"

# The arguments are the fence's --settings, then exactly the ones
# build_claude_cli_args("claude-opus-5-5", true) builds (claude_cli.rs).
setup ok
run || fail "ok: exited non-zero: $(cat "$case_dir/out.log")"
expected_args=(
  --settings
  '{"hooks":{"PreToolUse":[{"matcher":"Bash|Write|Edit|NotebookEdit","hooks":[{"type":"command","command":"python3 /Users/johnp/Code/Agent-Harness-Reconfig/ops/hooks/lane-fence.py"}]}]}}'
  -p --output-format stream-json --input-format stream-json --verbose
  --setting-sources project --disable-slash-commands --tools "" --no-session-persistence
  --prompt-suggestions false
  --append-system-prompt "You are answering inside LLM Wiki, which runs you with no tools: you cannot read files, run commands, search or fetch anything. Answer from the text of the user's message alone. This reply is your only turn and nothing in it is executed, so never write a tool call or tool-call markup, and never say you will come back with results later."
  --model claude-opus-5-5
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
)
cmp -s "$case_dir/argv" <(printf '%s\0' "${expected_args[@]}") \
  || fail "ok: arguments were: $(tr '\0' ' ' < "$case_dir/argv")"
cmp -s "$case_dir/stdin" "$case_dir/caller/in.stdin.jsonl" || fail "ok: stdin is not the file"
[ "$(cat "$case_dir/caller/out.jsonl")" = '{"type":"result","subtype":"success"}' ] \
  || fail "ok: stdout did not land in the output path"
ran_in="$(cat "$case_dir/cwd")"
[ "$ran_in" != "$(cd "$case_dir/caller" && pwd -P)" ] || fail "ok: claude ran in the caller's folder"
[ -e "$ran_in" ] && fail "ok: scratch folder $ran_in left behind"
grep -q "9.9.9 (Claude Code)" "$case_dir/out.log" || fail "ok: output does not name the claude version"

# An output folder that does not exist yet is made.
setup new-folder
run in.stdin.jsonl new/deeper/out.jsonl || fail "new folder: exited non-zero: $(cat "$case_dir/out.log")"
[ -s "$case_dir/caller/new/deeper/out.jsonl" ] || fail "new folder: no output"

# The CLI's exit status is the script's.
setup exit-status
run STUB_EXIT=3
[ $? -eq 3 ] || fail "exit status: claude's 3 not passed on"
[ -e "$(cat "$case_dir/cwd")" ] && fail "exit status: scratch folder left behind"

# Like the app (claude_cli.rs), CLAUDE_CONFIG_DIR is ~/.claude unless the
# caller names one; the lane marker reaches claude unchanged.
setup config-default
run
[ "$(cat "$case_dir/config-dir")" = "$case_dir/home/.claude" ] \
  || fail "config default: CLAUDE_CONFIG_DIR was $(cat "$case_dir/config-dir")"
setup config-kept
run CLAUDE_CONFIG_DIR=/elsewhere AHR_LANE_WORKTREE=/some/worktree
[ "$(cat "$case_dir/config-dir")" = /elsewhere ] \
  || fail "config kept: CLAUDE_CONFIG_DIR was $(cat "$case_dir/config-dir")"
[ "$(cat "$case_dir/marker")" = /some/worktree ] \
  || fail "config kept: marker was $(cat "$case_dir/marker")"

# The real lane fence lets the recorded command through as a Bash call in
# this worktree: the --settings it carries binds the nested session.
setup fence
run
worktree="$(cd "$here/../.." && pwd -P)"
if ! verdict="$(python3 - "$case_dir/argv" "$worktree" <<'EOF' | AHR_LANE_WORKTREE="$worktree" python3 "$fence"
import json, shlex, sys
args = open(sys.argv[1], 'rb').read().decode().split('\0')[:-1]
print(json.dumps({'tool_name': 'Bash', 'cwd': sys.argv[2],
                  'tool_input': {'command': shlex.join(['claude', *args])}}))
EOF
)"; then
  fail "fence: the hook did not run"
fi
[ -z "$verdict" ] || fail "fence: refused: $verdict"

if [ "$failures" -ne 0 ]; then echo "live-cli.test.sh: $failures failed"; exit 1; fi
echo "live-cli.test.sh: all passed"
