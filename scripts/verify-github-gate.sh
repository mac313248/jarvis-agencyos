#!/usr/bin/env bash
# scripts/verify-github-gate.sh
# Thin wrapper around the Node verifier (scripts/verify-github-gate.mjs),
# whose gate-evaluation logic is unit-tested (tests/support/verifier-gate.test.mjs).
#
# Run from a NORMAL terminal (not Cursor's sandboxed terminal — api.github.com
# is blocked there) where `gh` (macOS keychain login) and api.github.com are
# reachable:
#   bash scripts/verify-github-gate.sh
set -euo pipefail
exec node "$(dirname "$0")/verify-github-gate.mjs" "$@"
