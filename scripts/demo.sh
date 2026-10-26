#!/usr/bin/env bash
# Demo for the README GIF: one agent run, then a second run that the pre-check skips.
#
#   ./scripts/demo.sh [cnj-number] [--court <alias>]
#
# Needs DATAJUD_API_KEY and ANTHROPIC_API_KEY (in .env or the environment) and jq.
# Record it with VHS (`vhs scripts/demo.tape`) or asciinema.
set -euo pipefail
cd "$(dirname "$0")/.."

CASE="${1:-0713383-43.2025.8.07.0006}"
shift || true
STATE_DIR="$(mktemp -d)"
trap 'rm -rf "$STATE_DIR"' EXIT

say() { printf '\n\033[1;36m# %s\033[0m\n' "$*"; }

say "Run 1: no previous state, so Claude reads the case through the MCP tools"
npm run --silent agent -- "$CASE" --state-dir "$STATE_DIR" "$@" |
  jq '{summary: .summary | {statusCategory, currentStatus, needsLawyerAttention, attentionReasons, lastRelevantMovements}, toolCalls: .meta.toolCalls, usage: .meta.usage}'

say "Run 2: nothing changed on DataJud, so the pre-check skips the LLM call"
npm run --silent agent -- "$CASE" --state-dir "$STATE_DIR" "$@" |
  jq '{skipped, reason, tokensSpent}'
