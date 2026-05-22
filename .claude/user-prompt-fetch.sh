#!/usr/bin/env bash
# UserPromptSubmit hook: keep the Doco protocol fresh in the agent's
# context on every turn, AND pre-fetch the /search.json result for the
# user's prompt so the top-of-reply query indicator is pre-built.
#
# Wired from `.claude/settings.json`. Hook input (JSON on stdin) carries
# `.prompt`. Hook output is the JSON envelope Claude Code's hook runner
# expects: { hookSpecificOutput: { hookEventName: "UserPromptSubmit",
# additionalContext: "<text>" } }.
#
# Why this exists: SessionStart loads the canonical_instructions ONCE
# per session. As the context scrolls, the agent drifts. UserPromptSubmit
# fires on every message, so we re-push a tight protocol checklist AND
# a fresh search result.
#
# Env vars consumed (sourced from $PWD/.env if not in shell):
#   DOCO_ACCESS  opaque Doco access credential

set -u

# 1. Read hook input from stdin.
INPUT=$(cat 2>/dev/null || true)
PROMPT=""
if [ -n "$INPUT" ] && command -v jq >/dev/null 2>&1; then
  PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null || true)
fi

# 2. Load .env if present.
if [ -f "$PWD/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PWD/.env"
  set +a
fi

# Prefer DOCO_ACCESS. Older env names are accepted only as migration
# fallbacks so existing sessions can load and rewrite themselves.
if [ -z "${DOCO_ACCESS:-}" ] && [ -n "${DOCO_KEY:-}" ]; then
  DOCO_ACCESS="$DOCO_KEY"
fi
if [ -z "${DOCO_ACCESS:-}" ] && [ -n "${DOCO_TOKEN:-}" ]; then
  DOCO_ACCESS="$DOCO_TOKEN"
fi
if [ -z "${DOCO_ACCESS:-}" ] && [ -n "${DOCO_URL:-}" ]; then
  DOCO_ACCESS=$(printf '%s' "$DOCO_URL" | sed -nE 's|.*/agent/([0-9a-f]{64})/?$|\1|p')
fi

DOCO_HANDLE="${DOCO_HANDLE:-}"
# Canonical filename is DOCO.md; older repos shipped lowercase doco.md.
# On case-insensitive filesystems the two resolve to one file.
DOCO_MD_PATH=""
[ -f "$PWD/DOCO.md" ] && DOCO_MD_PATH="$PWD/DOCO.md"
[ -z "$DOCO_MD_PATH" ] && [ -f "$PWD/doco.md" ] && DOCO_MD_PATH="$PWD/doco.md"
if [ -z "$DOCO_HANDLE" ] && [ -n "$DOCO_MD_PATH" ]; then
  DOCO_HANDLE=$(sed -nE 's|.*https?://[^/ ]+/([A-Za-z0-9][A-Za-z0-9-]*)/?[ ).]*.*|\1|p' "$DOCO_MD_PATH" | head -1)
fi

# 3. Build the protocol reminder — short, deterministic, every turn.
# This is a per-turn pointer, NOT a restatement of canonical. The full
# canonical_instructions was loaded at SessionStart; duplicating it here
# creates drift the moment canonical is updated server-side.
read -r -d '' PROTOCOL_REMINDER <<'EOF' || true
## Doco protocol — per-turn reminder

Full canonical was loaded at SessionStart. This is the per-turn nudge, not a restatement.

**Query first.** The user's question — whatever it is — may already have a documented answer in this Doco. Skipping the query risks contradicting prior Decisions or duplicating nodes.

**Non-negotiable** every turn (one user prompt → your final answer, regardless of intermediate tool calls):

- Top of your first text output: render the `[🔮 Doco]` indicator (pre-built block below; paste verbatim). If it says `Not connected yet`, paste that line and skip the tally/footer until connection is fixed.
- Last line of your last text output: `[🔮 Doco] <handle>: **<N>** node(s) added/updated`. Renders even when N=0 — that's the no-op signal.

Lost the canonical from your context? Re-fetch with `node .agents/doco-agent-client.mjs bootstrap`.
EOF

# 4. Pre-fetch /search.json for the user's prompt.
QUERY_BLOCK=""
DISCONNECTED_REASON=""
if [ -z "${DOCO_ACCESS:-}" ]; then
  DISCONNECTED_REASON="missing DOCO_ACCESS — ask the project owner for an invite URL"
elif [ -z "${DOCO_HANDLE:-}" ]; then
  DISCONNECTED_REASON="missing DOCO.md Doco URL"
elif ! command -v node >/dev/null 2>&1; then
  DISCONNECTED_REASON="node is not installed"
elif [ ! -f "$PWD/.agents/doco-agent-client.mjs" ]; then
  DISCONNECTED_REASON="Doco agent client is missing at .agents/doco-agent-client.mjs"
elif ! command -v jq >/dev/null 2>&1; then
  DISCONNECTED_REASON="jq is not installed"
fi

if [ -n "$DISCONNECTED_REASON" ]; then
  QUERY_BLOCK=$(printf '\n\n## Doco connection for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] Not connected yet: %s\n\nDo not render any other Doco indicator, footer, or tally lines until the connection is fixed.\n' "$DISCONNECTED_REASON")
elif [ -n "$PROMPT" ]; then
  SEARCH_META=$(node "$PWD/.agents/doco-agent-client.mjs" search --q "$PROMPT" --limit 10 --meta 2>/dev/null || true)
  if ! printf '%s' "$SEARCH_META" | jq -e . >/dev/null 2>&1; then
    SEARCH_META='{"ok":false,"status":0,"code":"network","error":"doco.to unreachable"}'
  fi
  HTTP_STATUS=$(printf '%s' "$SEARCH_META" | jq -r '.status // 0' 2>/dev/null)
  SEARCH_CODE=$(printf '%s' "$SEARCH_META" | jq -r '.code // empty' 2>/dev/null)
  SEARCH_ERROR=$(printf '%s' "$SEARCH_META" | jq -r '.error // empty' 2>/dev/null)
  RESP=$(printf '%s' "$SEARCH_META" | jq -c '.body // empty' 2>/dev/null)
  if [ "$HTTP_STATUS" = "200" ] && [ -n "$RESP" ]; then
    COUNT=$(printf '%s' "$RESP" | jq -r '.count // 0' 2>/dev/null || echo 0)
    MS=$(printf '%s' "$RESP" | jq -r '.duration_ms // 0' 2>/dev/null || echo 0)
    SECS=$(awk -v ms="$MS" 'BEGIN { printf "%.1f", ms/1000 }')
    HITS=$(printf '%s' "$RESP" | jq -r '
      .hits[]? |
      "- " + .node_type + " [" + (.slug // .seq_id // .id) + "]: " +
        (if (.summary | length) > 120 then (.summary[:117] + "...") else .summary end)
    ' 2>/dev/null | head -10)
    QUERYING_VERBS=("Querying..." "Looking it up..." "Asking around..." "Reading the room..." "Sniffing for hits..." "Flipping through notes..." "Scanning the graph..." "Searching the lore..." "Peering into the orb..." "Combing the archive..." "Hunting for prior art..." "Pinging the memory..." "Cross-referencing..." "Checking what's known..." "Tracing the trail..." "Diving in..." "Polling the Doco..." "Skimming the index..." "Asking the oracle..." "Searching...")
    QUERYING_VERB="${QUERYING_VERBS[$RANDOM % ${#QUERYING_VERBS[@]}]}"
    QUERY_BLOCK=$(printf '\n\n## Pre-fetched query for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] %s\n[🔮 Doco] %s relevant nodes found (%ss)\n\nTop hits:\n%s\n' \
      "$QUERYING_VERB" "$COUNT" "$SECS" "$HITS")
    HITS_KEY=$(printf '%s' "$PWD" | shasum 2>/dev/null | awk '{print $1}' || printf 'default')
    HITS_FILE="${TMPDIR:-/tmp}/doco-last-hits-${HITS_KEY}.json"
    printf '%s' "$RESP" > "$HITS_FILE" 2>/dev/null || true
  else
    REASON=""
    case "$SEARCH_CODE:$HTTP_STATUS" in
      missing_access:*) REASON="missing DOCO_ACCESS — ask the project owner for an invite URL" ;;
      missing_doco_handle:*) REASON="missing DOCO.md Doco URL" ;;
      network:*|timeout:*|*:000|*:0) REASON="doco.to unreachable" ;;
      *:401) REASON="DOCO_ACCESS invalid or revoked — ask for a fresh invite URL" ;;
      *) REASON="${SEARCH_ERROR:-search failed with HTTP ${HTTP_STATUS}}" ;;
    esac
    case "$HTTP_STATUS" in
      000) REASON="doco.to unreachable" ;;
      401) REASON="DOCO_ACCESS invalid or revoked — ask for a fresh invite URL" ;;
    esac
    GUIDANCE=""
    if [ -n "$RESP" ] && { [ "$HTTP_STATUS" = "403" ] || [ "$HTTP_STATUS" = "404" ]; }; then
      GUIDANCE="$RESP"
    fi
    if [ -n "$GUIDANCE" ]; then
      FIRST_LINE=$(printf '%s' "$GUIDANCE" | head -n 1)
      REST=$(printf '%s' "$GUIDANCE" | tail -n +2)
      QUERY_BLOCK=$(printf '\n\n## Doco connection for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] Not connected yet: %s\n\nThen show the project owner this recovery guidance from the host (do not render any other Doco indicator, footer, or tally lines until the connection is fixed):\n\n%s\n' \
        "$FIRST_LINE" "$REST")
    else
      QUERY_BLOCK=$(printf '\n\n## Doco connection for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] Not connected yet: %s\n\nDo not render any other Doco indicator, footer, or tally lines until the connection is fixed.\n' "$REASON")
    fi
  fi
fi

# 5. Emit the JSON envelope.
FULL="${PROTOCOL_REMINDER}${QUERY_BLOCK}"
if command -v jq >/dev/null 2>&1; then
  jq -nc --arg c "$FULL" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $c}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Doco protocol reminder unavailable (jq missing). Render the query indicator at top + footer_lines after writes manually."}}\n'
fi
