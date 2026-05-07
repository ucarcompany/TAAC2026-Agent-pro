#!/usr/bin/env bash
# PreToolUse(WebFetch) hook — host allowlist for outbound web fetches.
# Mirrors the cookie-host allowlist enforced server-side in
# scripts/_taiji-http.mjs. Defense-in-depth: even if scripts are bypassed,
# Claude's WebFetch tool cannot hit attacker-controlled hosts.
set -euo pipefail

input="$(cat || true)"
url=$(printf '%s' "$input" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)

if [ -z "$url" ]; then
  exit 0
fi

host=$(printf '%s' "$url" | sed -n 's,^[a-zA-Z][a-zA-Z0-9+.-]*://\([^/?#]*\).*,\1,p' | tr 'A-Z' 'a-z')

case "$host" in
  arxiv.org|export.arxiv.org|api.github.com|raw.githubusercontent.com|github.com|serpapi.com|huggingface.co|*.huggingface.co|taiji.algo.qq.com|*.cos.ap-guangzhou.myqcloud.com|algo.qq.com)
    exit 0
    ;;
  *)
    printf 'guard-webfetch: blocked host: %s\n' "$host" >&2
    exit 2
    ;;
esac
