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
#   DOCO_URL  access URL of the shape https://doco.to/agent/<credential>/

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

# Prefer DOCO_KEY (the new env-var shape). For in-flight repos that
# still carry the old DOCO_URL=https://doco.to/agent/<hex>/, extract
# the 64-hex segment so the same hook works on both.
if [ -z "${DOCO_KEY:-}" ] && [ -n "${DOCO_URL:-}" ]; then
  DOCO_KEY=$(printf '%s' "$DOCO_URL" | sed -nE 's|.*/agent/([0-9a-f]{64})/?$|\1|p')
fi

# 3. Build the protocol reminder — short, deterministic, every turn.
read -r -d '' PROTOCOL_REMINDER <<'EOF' || true
## Doco protocol — apply this in your reply

Use Doco as a verb in client-facing prose: "Want me to doco it?", "Doco this decision", "Doco this ADR", "Doco the flow".

1. TOP OF THE TURN'S FIRST TEXT OUTPUT (once per turn, NOT on intermediate progress updates between tool calls): paste the pre-fetched Doco block FIRST.

   If the pre-fetched block says "[🔮 Doco] Not connected yet: <reason>", paste that exact line instead of any connected indicator. Do not render query/count/tally/footer lines while disconnected. Ask the project owner to re-onboard at https://doco.to/onboarding/create/agent.

   If connected and queried, render the two-line query indicator:
   [🔮 Doco] <querying-verb>
   [🔮 Doco] <N> relevant nodes found (<X.X>s)
   If you didn't query (greeting, one-word ack), emit nothing at the top — no "Not querying" placeholder, no fallback line. Absence is the signal.
   The pre-fetched connected block below has the verbs already picked at random plus real <N>/<X.Xs> — paste it verbatim.

2. AFTER EVERY WRITE (POST/PATCH/DELETE on ${DOCO_URL}api/*.json), only when connected: render every returned footer_lines entry verbatim, one per line, before the closing tally. Curl returning JSON is not enough; the user-facing reply must contain the operation lines. Shape:
   [🔮 Doco] <op-icon> <Type> <verb>: [<summary>](<url>) — <icon> <scope1>, <icon> <scope2>
   The summary is the markdown link to the entity. Never show the raw ULID. Scope tail omitted when no scopes. Last line in a batch carries (X.Xs) timing AFTER the scope tail — already there.

3. BEFORE DECLARING DONE: scan capture triggers. Scope names are BARE (no scope_ prefix) and match templates: user-flow changed → `user-flows` Decision. Bug fixed → `bugs` Decision + `bugs` Rule (`born_from: <decision_id>`). Framework touched (templates / hooks / canonical) → add `framework`. ADR-shaped → `adrs`. POST to ${DOCO_URL}api/decisions.json etc. **If instinct says skip, name the existing node you're relying on. If a high-vector_score hit already governs the change, PATCH it instead of skipping (PATCH ${DOCO_URL}api/<type-plural>/<id>.json with body_md_append).**

4. CLOSING LINE OF THE TURN (once per turn, on the LAST text output only — NOT on intermediate progress updates between tool calls; even when 0 writes):
   [🔮 Doco] <owner>/<doco>: **<N>** node(s) added/updated
   <N> = count of distinct entities you added/updated this turn (PATCH-3-fields-of-1-Decision = 1, not 3). The number MUST be wrapped in markdown bold (`**N**`). Singular when N == 1, plural otherwise (0 is plural). A "turn" is one user prompt → your complete answer, even when threaded through many tool calls; the tally bookends the turn, not each chunk.

The full canonical_instructions was loaded at session start. Re-fetch via `curl -fsS ${DOCO_URL}bootstrap.json` if you've lost track and are connected.
EOF

# 4. Pre-fetch /search.json for the user's prompt.
QUERY_BLOCK=""
DISCONNECTED_REASON=""
if [ -z "${DOCO_KEY:-}" ]; then
  DISCONNECTED_REASON="missing DOCO_KEY — ask the project owner for an invite URL"
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
  HTTP_STATUS=$(curl -sSL --max-time 5 -w '%{http_code}' -o "$TMP_RESP" \
    "https://doco.to/agent/${DOCO_KEY}/search.json?q=${ENC}&limit=10" 2>/dev/null || true)
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
    QUERYING_VERBS=("Querying..." "Looking it up..." "Asking around..." "Reading the room..." "Sniffing for hits..." "Flipping through notes..." "Scanning the graph..." "Searching the lore..." "Peering into the orb..." "Combing the archive..." "Hunting for prior art..." "Pinging the memory..." "Cross-referencing..." "Checking what's known..." "Tracing the trail..." "Diving in..." "Polling the Doco..." "Skimming the index..." "Asking the oracle..." "Searching...")
    QUERYING_VERB="${QUERYING_VERBS[$RANDOM % ${#QUERYING_VERBS[@]}]}"
    QUERY_BLOCK=$(printf '\n\n## Pre-fetched query for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] %s\n[🔮 Doco] %s relevant nodes found (%ss)\n\nTop hits:\n%s\n' \
      "$QUERYING_VERB" "$COUNT" "$SECS" "$HITS")
    HITS_KEY=$(printf '%s' "$PWD" | shasum 2>/dev/null | awk '{print $1}' || printf 'default')
    HITS_FILE="${TMPDIR:-/tmp}/doco-last-hits-${HITS_KEY}.json"
    printf '%s' "$RESP" > "$HITS_FILE" 2>/dev/null || true
  else
    REASON=""
    case "$HTTP_STATUS" in
      000) REASON="doco.to unreachable" ;;
      401) REASON="DOCO_KEY invalid or revoked — ask for a fresh invite URL" ;;
      *) REASON="search failed with HTTP ${HTTP_STATUS}" ;;
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
