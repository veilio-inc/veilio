#!/bin/bash
# Spec 033 scale check: the same headless session on this whole repository,
# without the guard, with it on a fresh map, and again on the map the first
# session built. check-scale.mjs then reads what each one sent the model.
#
#   bash plugins/veilio-guard/tests/live/run-scale.sh [model]
#
# Found three bugs the unit tests and run-live.sh missed (everyday words from
# string literals masking a git log, tool errors that did not fit their
# schema, fragments detected as the wrong language). Spends a little more
# model usage than run-live.sh. Needs Claude Code signed in.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$PLUGIN/../.." && pwd)"
MODEL="${1:-claude-haiku-4-5-20251001}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone -q --local "$REPO" "$WORK/repo"
cd "$WORK/repo"
PROMPT='Do these steps in order, then stop. 1) Read packages/engine/src/engine.ts in full. 2) Read packages/engine/src/languages.ts in full. 3) Run: grep -rn "restore" packages --include=*.ts | head -300 4) Run: git log --oneline | head -150 5) Read packages/cli/src/index.ts. 6) Reply with five lines on how restore works.'
run() {
  local name=$1; shift
  claude -p "$PROMPT" "$@" --model "$MODEL" \
    --allowedTools "Read,Grep,Glob,Bash(grep:*),Bash(git log:*)" \
    --output-format stream-json --verbose < /dev/null > "$WORK/$name.jsonl" 2> "$WORK/$name.err" || true
}
run plain
run guard-cold --plugin-dir "$PLUGIN"
run guard-warm --plugin-dir "$PLUGIN"
cp .veilio/map.json "$WORK/map.json"
node "$HERE/check-scale.mjs" "$WORK"
