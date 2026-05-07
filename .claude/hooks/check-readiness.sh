#!/usr/bin/env bash
# SubagentStart hook — refuses to launch high-risk subagents (e.g.
# experiment-operator) before the Stage-0 readiness gate is "ready".
# Currently a placeholder; the relevant subagents land in M3+.
set -euo pipefail

report="taiji-output/state/readiness.json"
if [ ! -f "$report" ]; then
  echo "check-readiness: $report missing — run \`taac2026 readiness check\` first" >&2
  exit 2
fi

status=$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$report" | head -n1)
if [ "$status" != "ready" ]; then
  echo "check-readiness: status=$status — gate not ready" >&2
  exit 2
fi
exit 0
