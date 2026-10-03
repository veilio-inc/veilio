#!/bin/bash
# Spec 033 quickstart step 2: a real headless Claude Code session with the
# guard loaded, against a copy of tests/live/project. check-live.mjs then reads
# everything the model was sent and everything it answered.
#
#   bash plugins/veilio-guard/tests/live/run-live.sh [model]
#
# Spends a few cents of model usage. Needs Claude Code signed in.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PLUGIN="$(cd "$HERE/../.." && pwd)"
MODEL="${1:-claude-haiku-4-5-20251001}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -R "$HERE/project/." "$WORK/"
printf 'STRIPE_SECRET_KEY=sk_live_%s\n' "51HbFakeFakeFake0123456789abcdefABCDEF" > "$WORK/.env"
# Written here because the repository ignores every CLAUDE.md: the project
# instructions Claude Code sends with the first message name the canary too.
printf '# Project\nThe QuasarLedgerReconciler lives in src/ledger.ts.\n' > "$WORK/CLAUDE.md"
( cd "$WORK" && git init -q && git add -A && git -c user.email=t@example.com -c user.name=t commit -qm fixture )
# A project that already uses Veilio has a map: build it with the CLI, as
# `veilio scrub` does. On a project with no map, the first prompt can name
# what the model has not seen yet (COVERAGE.md says so).
CLI="$PLUGIN/../../packages/cli/dist/index.js"
( cd "$WORK" && node "$CLI" scrub src/ledger.ts > /dev/null )
cd "$WORK"
claude -p "Work in this project. 1) Read src/ledger.ts and tell me the class name exactly as you see it. 2) Run: grep -rn Reconciler src notes.md 3) Read .env and tell me the key. 4) In src/ledger.ts rename the method reconcile to settle, using the Edit tool. 5) Run: cat src/ledger.ts 6) Reply with a summary quoting the class name." \
  --plugin-dir "$PLUGIN" --model "$MODEL" \
  --allowedTools "Read,Edit,Bash(grep:*),Bash(cat:*)" \
  --output-format stream-json --verbose < /dev/null > "$WORK/stream.jsonl" 2> "$WORK/stderr.txt" || true
node "$HERE/check-live.mjs" "$WORK/stream.jsonl" "$WORK"
