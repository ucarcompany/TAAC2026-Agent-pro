#!/usr/bin/env bash
# PreToolUse(Bash) hook — enforces invariants beyond settings.deny.
# Reads JSON from stdin: {tool: "Bash", tool_input: {command: "..."}}.
# Exit 0 = allow, exit 2 = block (Claude shows the reason and aborts).
set -euo pipefail

input="$(cat || true)"

# Best-effort extraction without jq dependency.
cmd=$(printf '%s' "$input" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)

if [ -z "$cmd" ]; then
  exit 0
fi

block() {
  printf 'guard-bash: blocked: %s\n' "$1" >&2
  exit 2
}

# 1) submit --execute requires a fresh review token in state/.
case "$cmd" in
  *"taac2026 submit"*"--execute"*|*"submit-taiji.mjs"*"--execute"*)
    if [ ! -f "taiji-output/state/.review-token-submit" ]; then
      block "submit --execute requires taiji-output/state/.review-token-submit (run review-gate Skill first)"
    fi
    ;;
esac

# 2) Reading secrets via cat/head/tail/less is denied (defense-in-depth on
#    top of settings.json deny list).
case "$cmd" in
  *cat*"secrets/"*|*head*"secrets/"*|*tail*"secrets/"*|*less*"secrets/"*)
    block "reading taiji-output/secrets/* via shell is denied"
    ;;
esac

# 3) Refuse rm -rf on workspace root or taiji-output/.
case "$cmd" in
  *"rm -rf"*"taiji-output"*|*"rm -rf "*"/"*|*"rm -rf ."*)
    block "rm -rf against taiji-output / workspace root is denied"
    ;;
esac

# 4) SSH / SCP / RSYNC: only via ~/.ssh/config aliases listed in
#    taiji-output/state/allowed-hosts.txt. Refuse password-based tooling
#    and refuse user@host / IP direct shapes which leak credentials in
#    process listings.
case "$cmd" in
  *sshpass*|*"expect "*ssh*)
    block "password-based SSH (sshpass / expect) is denied — use ~/.ssh/config + ed25519 keys"
    ;;
esac

# Refuse any ssh/scp/rsync that contains user@host (e.g. root@1.2.3.4).
# Aliases never contain '@', so this strips the credential-leak shape.
if printf '%s' "$cmd" | grep -qE '\b(ssh|scp|rsync)\b[^|;]*[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+'; then
  block "ssh/scp/rsync with user@host is denied — use a ~/.ssh/config alias listed in taiji-output/state/allowed-hosts.txt"
fi

# Refuse ssh -p <port> ... root@<ip-or-host> shape and any direct IPv4 target.
if printf '%s' "$cmd" | grep -qE '\b(ssh|scp|rsync)\b[^|;]*\b([0-9]{1,3}\.){3}[0-9]{1,3}\b'; then
  block "ssh/scp/rsync to a literal IP is denied — use a ~/.ssh/config alias listed in taiji-output/state/allowed-hosts.txt"
fi

exit 0
