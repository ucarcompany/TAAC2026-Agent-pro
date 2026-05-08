#!/usr/bin/env bash
# POSIX wrapper for SSH_ASKPASS. Invokes the Node helper. Stays
# silent on stderr so password retrieval never lands in shell history /
# CI logs.
exec node "$(dirname "$0")/_askpass.mjs" "$@"
