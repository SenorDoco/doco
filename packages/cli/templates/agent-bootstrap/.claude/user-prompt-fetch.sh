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
#    only carries the DOCO_TOKEN secret. DOCO_ID lives in AGENTS.md
#    (committed, non-secret) — read it from there if it's not in env.
#    Legacy repos with DOCO_ID still in .env keep working: env wins.
if [ -f "$PWD/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PWD/.env"
  set +a
fi
DOCO_BASE_URL="https://doco.to"
DOCO_ID="${DOCO_ID:-}"
if [ -z "$DOCO_ID" ]; then
  for f in "$PWD/AGENTS.md" "$PWD/CLAUDE.md"; do
    if [ -f "$f" ]; then
      DOCO_ID=$(grep -oE 'doco_[A-Za-z0-9]+' "$f" | head -1)
      [ -n "$DOCO_ID" ] && break
    fi
  done
fi

# 3. Build the protocol reminder — short, deterministic, every turn.
#    Kept under 800 chars so the per-turn token cost stays bounded.
read -r -d '' PROTOCOL_REMINDER <<'EOF' || true
## Doco protocol — apply this in your reply

1. TOP OF THE TURN'S FIRST TEXT OUTPUT (once per turn, NOT on intermediate progress updates between tool calls): paste the pre-fetched Doco block FIRST.

   If the pre-fetched block says "[🔮 Doco] Not connected yet: <reason>", paste that exact line instead of any connected indicator. Do not render query/count/tally/footer lines while disconnected. Ask the project owner to authorize with `doco login --host https://doco.to`.

   If connected and queried, render the two-line query indicator:
   [🔮 Doco] <querying-verb>
   [🔮 Doco] <N> relevant nodes found (<X.X>s)
   If you didn't query (greeting, one-word ack), emit nothing at the top — no "Not querying" placeholder, no fallback line. Absence is the signal.
   The pre-fetched connected block below has the verbs already picked at random plus real <N>/<X.Xs> — paste it verbatim.

2. AFTER EVERY WRITE (POST/PATCH/DELETE on /api/*.json), only when connected: render every returned footer_lines entry verbatim, one per line, before the closing tally. Running `doco capture` / `doco patch` is not enough; the user-facing reply must contain the operation lines. Shape:
   [🔮 Doco] <op-icon> <Type> <verb>: [<summary>](<url>) — <icon> <scope1>, <icon> <scope2>
   The summary is the markdown link to the entity. Never show the raw ULID. Scope tail omitted when no scopes. Last line in a batch carries (X.Xs) timing AFTER the scope tail — already there.

3. BEFORE DECLARING DONE: scan capture triggers. Scope names are BARE (no scope_ prefix) and match templates: user-flow changed → `user-flows` Decision. Bug fixed → `bugs` Decision + `bugs` Rule (`born_from: <decision_id>`). Framework touched (CLI / hooks / canonical) → add `framework`. ADR-shaped → `adrs`. POST to /api/decisions.json etc. via the host's capture endpoints. **If instinct says skip, name the existing node you're relying on — "CLI can't capture X" or "too small for a Decision" aren't naming a node. If a high-vector_score hit already governs the change, PATCH it instead of skipping.**

4. CLOSING LINE OF THE TURN (once per turn, on the LAST text output only — NOT on intermediate progress updates between tool calls; even when 0 writes):
   [🔮 Doco] <doco_id>: **<N>** node(s) added/updated
   <N> = count of distinct entities you added/updated this turn (PATCH-3-fields-of-1-Decision = 1, not 3). The number MUST be wrapped in markdown bold (`**N**`). Singular when N == 1, plural otherwise (0 is plural). A "turn" is one user prompt → your complete answer, even when threaded through many tool calls; the tally bookends the turn, not each chunk.

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
    # For 403 (no_access) and 404 (not_found) the host returns rich
    # recovery guidance in the response body (see
    # packages/web/app/lib/missing-doco-guidance.server.ts). Prefer
    # that body verbatim — it tells the user how to recover instead
    # of just naming the failure. Fall back to a short reason string
    # when the body is missing (host down, unauthorized token, etc.).
    REASON=""
    case "$HTTP_STATUS" in
      000) REASON="doco.to unreachable" ;;
      401) REASON="DOCO_TOKEN is missing or expired; ask the project owner to authorize with doco login --host https://doco.to" ;;
      *) REASON="search failed with HTTP ${HTTP_STATUS}" ;;
    esac
    GUIDANCE=""
    if [ -n "$RESP" ] && { [ "$HTTP_STATUS" = "403" ] || [ "$HTTP_STATUS" = "404" ]; }; then
      GUIDANCE="$RESP"
    fi
    if [ -n "$GUIDANCE" ]; then
      # First line of the body is the title — use it for the indicator
      # so the [🔮 Doco] Not connected yet: line stays single-logical-line.
      # Show the rest below as the recovery section.
      FIRST_LINE=$(printf '%s' "$GUIDANCE" | head -n 1)
      REST=$(printf '%s' "$GUIDANCE" | tail -n +2)
      QUERY_BLOCK=$(printf '\n\n## Doco connection for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] Not connected yet: %s\n\nThen show the project owner this recovery guidance from the host (do not render any other Doco indicator, footer, or tally lines until the connection is fixed):\n\n%s\n' \
        "$FIRST_LINE" "$REST")
    else
      QUERY_BLOCK=$(printf '\n\n## Doco connection for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] Not connected yet: %s\n\nDo not render any other Doco indicator, footer, or tally lines until the connection is fixed.\n' "$REASON")
    fi
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
