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
#   DOCO_HOST   required for the search query
#   DOCO_TOKEN  optional bearer token (gates per-Doco context)
#   DOCO_SLUG   "<owner>/<doco>" — which Doco to query (e.g. "acme/payments")
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

# 2. Load .env if env vars aren't already set in shell.
if [ -z "${DOCO_HOST:-}" ] && [ -f "$PWD/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PWD/.env"
  set +a
fi
DOCO_HOST="${DOCO_HOST:-}"
DOCO_SLUG="${DOCO_SLUG:-}"

# 3. Build the protocol reminder — short, deterministic, every turn.
#    Kept under 800 chars so the per-turn token cost stays bounded.
read -r -d '' PROTOCOL_REMINDER <<'EOF' || true
## Doco protocol — apply this in your reply

1. TOP OF REPLY: render the two-line query indicator FIRST:
   [🔮 Doco] <querying-verb>
   [🔮 Doco] <loading-verb> <owner>/<doco>. <N> relevant nodes found (<X.X>s)
   (Or "[🔮 Doco] Not querying Doco" on one line if you genuinely don't.)
   The pre-fetched block below has the verbs already picked at random plus real <N>/<X.Xs> — paste it verbatim. See the canonical for the 20+20 verb lists if you ever need to pick yourself.

2. AFTER EVERY WRITE (POST/PATCH/DELETE on /api/*.json): render footer_lines from the response verbatim, one per line. Shape:
   [🔮 Doco] <op-icon> <Type> <verb>: [<slug>](<url>): <details> — <icon> <scope1>, <icon> <scope2>
   The slug is a markdown link to the entity. Never show the raw ULID — use slug/seq_id only. Scope tail omitted when no scopes. Last line in a batch carries (X.Xs) timing AFTER the scope tail — already there.

3. BEFORE DECLARING DONE: scan capture triggers. Scope names are BARE (no scope_ prefix) and match templates: user-flow changed → `user-flows` Decision. Bug fixed → `bugs` Decision + `bugs` Rule (`born_from: <decision_id>`). Framework touched (CLI / hooks / canonical) → add `framework`. ADR-shaped → `adrs`. POST to /api/decisions.json etc. via the host's capture endpoints. **If instinct says skip, name the existing node you're relying on — "CLI can't capture X" or "too small for a Decision" aren't naming a node. If a high-vector_score hit already governs the change, PATCH it instead of skipping.**

4. LAST LINE OF EVERY MESSAGE (no exceptions, even with 0 writes):
   [🔮 Doco] <owner>/<doco>: **<N>** node(s) added/updated
   <N> = count of distinct entities you added/updated this turn (PATCH-3-fields-of-1-Decision = 1, not 3). The number MUST be wrapped in markdown bold (`**N**`). Singular when N == 1, plural otherwise (0 is plural).

The full canonical_instructions was loaded at session start. Re-fetch via `curl -s $DOCO_HOST/api/v1/agent-bootstrap` if you've lost track.
EOF

# 4. Pre-fetch /search.json for the user's prompt so the agent doesn't
#    have to. Skip silently if anything's missing — degrade to just the
#    reminder rather than crash the hook.
QUERY_BLOCK=""
if [ -n "$DOCO_HOST" ] && [ -n "$DOCO_SLUG" ] && [ -n "$PROMPT" ] \
   && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  ENC=$(printf '%s' "$PROMPT" | jq -sRr @uri 2>/dev/null || true)
  AUTH_CURL=""
  if [ -n "${DOCO_TOKEN:-}" ]; then
    AUTH_CURL="-H 'Authorization: Bearer ${DOCO_TOKEN}'"
  fi
  RESP=$(eval curl -sf --max-time 5 "$AUTH_CURL" \
    "'${DOCO_HOST}/${DOCO_SLUG}/search.json?q=${ENC}&limit=10'" 2>/dev/null || true)
  if [ -n "$RESP" ]; then
    COUNT=$(printf '%s' "$RESP" | jq -r '.count // 0' 2>/dev/null || echo 0)
    MS=$(printf '%s' "$RESP" | jq -r '.duration_ms // 0' 2>/dev/null || echo 0)
    SECS=$(awk -v ms="$MS" 'BEGIN { printf "%.1f", ms/1000 }')
    HITS=$(printf '%s' "$RESP" | jq -r '
      .hits[]? |
      "- " + .node_type + " [" + (.slug // .seq_id // .id) + "]: " +
        (if (.summary | length) > 120 then (.summary[:117] + "...") else .summary end)
    ' 2>/dev/null | head -10)
    # Random verbs — pick one of 20 each. The variety is the point;
    # the structured fields (slug, count, timing) stay identical.
    LOADING_VERBS=("Connected to" "Tuned into" "Listening to" "Wired up to" "Synced with" "Plugged into" "Online with" "Reading" "Hooked into" "Linked to" "Eyes on" "Riding shotgun on" "Pinned to" "Threaded into" "Locked onto" "Channel open:" "Live on" "Mind-melded with" "Pulled up" "Holding the file on")
    QUERYING_VERBS=("Querying..." "Looking it up..." "Asking around..." "Reading the room..." "Sniffing for hits..." "Flipping through notes..." "Scanning the graph..." "Searching the lore..." "Peering into the orb..." "Combing the archive..." "Hunting for prior art..." "Pinging the memory..." "Cross-referencing..." "Checking what's known..." "Tracing the trail..." "Diving in..." "Polling the Doco..." "Skimming the index..." "Asking the oracle..." "Searching...")
    LOADING_VERB="${LOADING_VERBS[$RANDOM % ${#LOADING_VERBS[@]}]}"
    QUERYING_VERB="${QUERYING_VERBS[$RANDOM % ${#QUERYING_VERBS[@]}]}"
    QUERY_BLOCK=$(printf '\n\n## Pre-fetched query for THIS prompt — paste as your top-of-reply indicator\n\n[🔮 Doco] %s\n[🔮 Doco] %s %s. %s relevant nodes found (%ss)\n\nTop hits:\n%s\n' \
      "$QUERYING_VERB" "$LOADING_VERB" "$DOCO_SLUG" "$COUNT" "$SECS" "$HITS")
    # Persist the full hits JSON for cross-hook reads (PostToolUse path-match).
    # Namespace by $PWD hash so concurrent worktrees don't stomp each other.
    # The PostToolUse hook reads this on every Edit/Write tool call.
    HITS_KEY=$(printf '%s' "$PWD" | shasum 2>/dev/null | awk '{print $1}' || printf 'default')
    HITS_FILE="${TMPDIR:-/tmp}/doco-last-hits-${HITS_KEY}.json"
    printf '%s' "$RESP" > "$HITS_FILE" 2>/dev/null || true
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
