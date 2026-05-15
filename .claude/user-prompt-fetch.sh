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
# Why this exists: SessionStart loads the 24KB canonical_instructions
# ONCE per session. As the context scrolls, the agent drifts — forgets
# to render the query indicator, forgets footer lines, forgets capture
# triggers. UserPromptSubmit fires on every message, so we re-push a
# tight protocol checklist AND a fresh search result. Cost: ~1-4KB of
# additionalContext per turn; benefit: structural compliance.
#
# Env vars consumed (sourced from $PWD/.env if not in shell):
#   DOCO_TOKEN  optional bearer token (gates per-Doco context)
#   DOCO_ID     "doco_..." — which Doco to query
#
# Per the `claude-md-strong-bootstrap-and-session-start-hook` Decision +
# the `user-prompt-submit-hook-keeps-protocol-fresh` Decision (this
# commit's iteration).

set -u

# 1. Read hook input from stdin.
INPUT=$(cat 2>/dev/null || true)
PROMPT=""
if [ -n "$INPUT" ] && command -v jq >/dev/null 2>&1; then
  PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // ""' 2>/dev/null || true)
fi

# 2. Load .env if present. The production host is fixed at doco.to; env
#    only carries identity + secret material.
if [ -f "$PWD/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PWD/.env"
  set +a
fi
DOCO_BASE_URL="https://doco.to"
DOCO_ID="${DOCO_ID:-}"

# 3. Build the protocol reminder — short, deterministic, every turn.
#    Kept under 800 chars so the per-turn token cost stays bounded.
read -r -d '' PROTOCOL_REMINDER <<'EOF' || true
## Doco protocol — apply this in your reply

1. TOP OF REPLY: paste the pre-fetched Doco block FIRST.

   If the pre-fetched block says "[🔮 Doco] Not connected yet: <reason>", paste that exact line instead of any connected indicator. Do not render query/count/tally/footer lines while disconnected. Ask the project owner to authorize with `doco login --host https://doco.to`.

   If connected and queried, render the two-line query indicator:
   [🔮 Doco] <querying-verb>
   [🔮 Doco] <loading-verb> <doco_id>. <N> relevant nodes found (<X.X>s)
   (Or "[🔮 Doco] Not querying Doco" on one line if you genuinely don't.)
   The pre-fetched connected block below has the verbs already picked at random plus real <N>/<X.Xs> — paste it verbatim.

2. AFTER EVERY WRITE (POST/PATCH/DELETE on /api/*.json), only when connected: render footer_lines from the response verbatim, one per line. Shape:
   [🔮 Doco] <op-icon> <Type> <verb>: [<slug>](<url>): <details> — <icon> <scope1>, <icon> <scope2>
   The slug is a markdown link to the entity. Never show the raw ULID — use slug/seq_id only. Scope tail omitted when no scopes. Last line in a batch carries (X.Xs) timing AFTER the scope tail — already there.

3. BEFORE DECLARING DONE: scan capture triggers. Scope names are BARE (no scope_ prefix) and match templates: user-flow changed → `user-flows` Decision. Bug fixed → `bugs` Decision + `bugs` Rule (`born_from: <decision_id>`). Framework touched (CLI / hooks / canonical) → add `framework`. ADR-shaped → `adrs`. POST to /api/decisions.json etc. via the host's capture endpoints. **If instinct says skip, name the existing node you're relying on — "CLI can't capture X" or "too small for a Decision" aren't naming a node. If a high-vector_score hit already governs the change, PATCH it instead of skipping.**

4. LAST LINE OF EVERY CONNECTED MESSAGE (even with 0 writes):
   [🔮 Doco] <doco_id>: **<N>** node(s) added/updated
   <N> = count of distinct entities you added/updated this turn (PATCH-3-fields-of-1-Decision = 1, not 3). The number MUST be wrapped in markdown bold (`**N**`). Singular when N == 1, plural otherwise (0 is plural).

The full canonical_instructions was loaded at session start. Re-fetch via `curl -s https://doco.to/api/v1/agent-bootstrap?id=$DOCO_ID -H "Authorization: Bearer $DOCO_TOKEN"` if you've lost track and are connected.
EOF

# 4. Pre-fetch /search.json for the user's prompt so the agent doesn't
#    have to. If anything needed for access is missing, pre-build the
#    disconnected indicator so the agent never presents as connected.
QUERY_BLOCK=""
DISCONNECTED_REASON=""
if [ -z "${DOCO_ID:-}" ]; then
  DISCONNECTED_REASON="missing DOCO_ID"
elif [ -z "${DOCO_TOKEN:-}" ]; then
  DISCONNECTED_REASON="missing DOCO_TOKEN; ask the project owner to authorize with doco login --host https://doco.to"
elif ! command -v curl >/dev/null 2>&1; then
  DISCONNECTED_REASON="curl is not installed"
elif ! command -v jq >/dev/null 2>&1; then
  DISCONNECTED_REASON="jq is not installed"
fi

if [ -n "$DISCONNECTED_REASON" ]; then
  QUERY_BLOCK=$(printf '\n\n## Doco connection for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] Not connected yet: %s\n\nDo not render any other Doco indicator, footer, or tally lines until the connection is fixed.\n' "$DISCONNECTED_REASON")
elif [ -n "$PROMPT" ]; then
  ENC=$(printf '%s' "$PROMPT" | jq -sRr @uri 2>/dev/null || true)
  TMP_RESP="${TMPDIR:-/tmp}/doco-search-$$.json"
  HTTP_STATUS=$(curl -sS --max-time 5 -w '%{http_code}' -o "$TMP_RESP" \
    -H "Authorization: Bearer ${DOCO_TOKEN}" \
    "${DOCO_BASE_URL}/by-id/${DOCO_ID}/search.json?q=${ENC}&limit=10" 2>/dev/null || true)
  RESP=$(cat "$TMP_RESP" 2>/dev/null || true)
  rm -f "$TMP_RESP" 2>/dev/null || true
  if [ "$HTTP_STATUS" = "200" ] && [ -n "$RESP" ]; then
    COUNT=$(printf '%s' "$RESP" | jq -r '.count // 0' 2>/dev/null || echo 0)
    MS=$(printf '%s' "$RESP" | jq -r '.duration_ms // 0' 2>/dev/null || echo 0)
    SECS=$(awk -v ms="$MS" 'BEGIN { printf "%.1f", ms/1000 }')
    HITS=$(printf '%s' "$RESP" | jq -r '
      .hits[]? |
      "- " + .node_type + " [" + (.slug // .seq_id // .id) + "]: " +
        (if (.summary | length) > 120 then (.summary[:117] + "...") else .summary end)
    ' 2>/dev/null | head -10)
    # Random verbs — pick one at random. The variety is the point;
    # the structured fields (slug, count, timing) stay identical.
    LOADING_VERBS=("Connected to" "Tuned into" "Listening to" "Wired up to" "Synced with" "Plugged into" "Online with" "Reading" "Hooked into" "Eyes on" "Riding shotgun on" "Pinned to" "Threaded into" "Locked onto" "Channel open:" "Live on" "Mind-melded with" "Pulled up" "Holding the file on")
    QUERYING_VERBS=("Querying..." "Looking it up..." "Asking around..." "Reading the room..." "Sniffing for hits..." "Flipping through notes..." "Scanning the graph..." "Searching the lore..." "Peering into the orb..." "Combing the archive..." "Hunting for prior art..." "Pinging the memory..." "Cross-referencing..." "Checking what's known..." "Tracing the trail..." "Diving in..." "Polling the Doco..." "Skimming the index..." "Asking the oracle..." "Searching...")
    LOADING_VERB="${LOADING_VERBS[$RANDOM % ${#LOADING_VERBS[@]}]}"
    QUERYING_VERB="${QUERYING_VERBS[$RANDOM % ${#QUERYING_VERBS[@]}]}"
    QUERY_BLOCK=$(printf '\n\n## Pre-fetched query for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] %s\n[🔮 Doco] %s %s. %s relevant nodes found (%ss)\n\nTop hits:\n%s\n' \
      "$QUERYING_VERB" "$LOADING_VERB" "$DOCO_ID" "$COUNT" "$SECS" "$HITS")
    # Persist the full hits JSON for cross-hook reads (PostToolUse path-match).
    # Namespace by $PWD hash so concurrent worktrees don't stomp each other.
    # The PostToolUse hook reads this on every Edit/Write tool call.
    HITS_KEY=$(printf '%s' "$PWD" | shasum 2>/dev/null | awk '{print $1}' || printf 'default')
    HITS_FILE="${TMPDIR:-/tmp}/doco-last-hits-${HITS_KEY}.json"
    printf '%s' "$RESP" > "$HITS_FILE" 2>/dev/null || true
  else
    REASON="search failed"
    case "$HTTP_STATUS" in
      000) REASON="doco.to unreachable" ;;
      401|403) REASON="token cannot access this Doco; ask the project owner to authorize with doco login --host https://doco.to" ;;
      404) REASON="Doco ID not found or inaccessible: ${DOCO_ID}" ;;
      *) REASON="search failed with HTTP ${HTTP_STATUS}" ;;
    esac
    QUERY_BLOCK=$(printf '\n\n## Doco connection for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] Not connected yet: %s\n\nDo not render any other Doco indicator, footer, or tally lines until the connection is fixed.\n' "$REASON")
  fi
fi

# 5. Emit the JSON envelope. additionalContext = reminder + pre-fetch.
FULL="${PROTOCOL_REMINDER}${QUERY_BLOCK}"
if command -v jq >/dev/null 2>&1; then
  jq -nc --arg c "$FULL" \
    '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $c}}'
else
  # jq missing — degrade. Output a minimal envelope referring the agent
  # to the manual reminder.
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Doco protocol reminder unavailable (jq missing). Render the query indicator at top + footer_lines after writes manually; see CANONICAL_INSTRUCTIONS."}}\n'
fi
