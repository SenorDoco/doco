#!/usr/bin/env bash
# PostToolUse hook: after Edit/Write tool calls, cross-reference the
# touched file against the prompt's pre-fetched /search.json hits. If a
# Decision with vector_score > 0.45 names this file's basename or
# relative path inside its body, inject an additionalContext block
# nudging the agent to PATCH that Decision rather than skip-and-rationalize.
#
# Wired from `.claude/settings.json`. Hook input (JSON on stdin) carries:
#   .hook_event_name = "PostToolUse"
#   .tool_name       = "Edit" | "Write" | "MultiEdit" | "Bash" | ...
#   .tool_input      = { file_path: "...", ... } for Edit/Write
#   .tool_response   = { content, isError }
#
# Hook output is the JSON envelope:
#   { "hookSpecificOutput": { "hookEventName": "PostToolUse",
#                             "additionalContext": "<nudge text>" } }
#
# Soft nudge — never blocks the tool call. Silent exit 0 on every
# failure path (no hits cached, no jq, no Decision body matches, etc).
#
# Per ADR-141 (decision_01KRK9P1FPF5ZAPJ4DXAKPXYFJ), item 8: catch
# context-scrolled drift the moment an Edit lands, while the relevant
# governing Decision is still surfaceable.

set -u

# 1. Read hook input.
INPUT=$(cat 2>/dev/null || true)
if [ -z "$INPUT" ] || ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || true)
case "$TOOL_NAME" in
  Edit|Write|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || true)
[ -z "$FILE_PATH" ] && exit 0

# 2. Load .env so we have $PWD-ish context and DOCO_ID for the nudge URL.
if [ -f "$PWD/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PWD/.env"
  set +a
fi
DOCO_BASE_URL="https://doco.to"
DOCO_ID="${DOCO_ID:-}"

# 3. Locate the pre-fetched hits file written by user-prompt-fetch.sh.
HITS_KEY=$(printf '%s' "$PWD" | shasum 2>/dev/null | awk '{print $1}' || printf 'default')
HITS_FILE="${TMPDIR:-/tmp}/doco-last-hits-${HITS_KEY}.json"
[ -f "$HITS_FILE" ] || exit 0
[ -s "$HITS_FILE" ] || exit 0

# 4. Compute substrings to search Decision bodies for.
#    Conservative match: basename + repo-relative path (slashes stripped of
#    leading $PWD). Decisions cite files in many shapes — basename catches
#    the most, relative path narrows for ambiguous basenames like "index.ts".
BASENAME=$(basename -- "$FILE_PATH")
RELPATH="$FILE_PATH"
case "$FILE_PATH" in
  "$PWD"/*) RELPATH="${FILE_PATH#$PWD/}" ;;
esac

# 5. Find Decisions with vector_score > 0.45 whose body mentions either
#    substring. We need the body, which /search.json hits DON'T carry —
#    they expose summary + file_path. Match against summary first; if no
#    summary hit, optionally fall back to reading the file_path (it's
#    local: docos/<owner>/<doco>/decisions/<id>.md).
MATCH_JSON=$(jq -c --arg b "$BASENAME" --arg r "$RELPATH" '
  [ .hits[]?
    | select(.node_type == "decision")
    | select((.vector_score // 0) > 0.45)
    | select(
        ((.summary // "") | contains($b))
        or ((.summary // "") | contains($r))
        or ((.file_path // "") | contains("/decisions/"))
      )
  ]
' "$HITS_FILE" 2>/dev/null || printf '[]')

# Stage 2: for high-score Decisions whose summary didn't mention the path,
# grep their on-disk body. Keep this bounded — top 5 by vector_score only.
DEEP_MATCH=$(jq -c --arg b "$BASENAME" --arg r "$RELPATH" '
  [ .hits[]?
    | select(.node_type == "decision")
    | select((.vector_score // 0) > 0.45)
    | { id, summary, file_path, vector_score, slug: (.slug // .seq_id // .id) }
  ] | sort_by(-.vector_score) | .[0:5]
' "$HITS_FILE" 2>/dev/null || printf '[]')

FINAL_MATCHES="[]"
if [ "$DEEP_MATCH" != "[]" ] && [ -n "$DEEP_MATCH" ]; then
  # Read each candidate's file_path, grep for basename/relpath, keep matches.
  COUNT=$(printf '%s' "$DEEP_MATCH" | jq 'length' 2>/dev/null || echo 0)
  i=0
  ACC="[]"
  while [ "$i" -lt "$COUNT" ]; do
    CAND=$(printf '%s' "$DEEP_MATCH" | jq -c ".[$i]" 2>/dev/null)
    CFP=$(printf '%s' "$CAND" | jq -r '.file_path // ""' 2>/dev/null)
    if [ -n "$CFP" ] && [ -f "$CFP" ]; then
      if grep -qF -- "$BASENAME" "$CFP" 2>/dev/null \
         || grep -qF -- "$RELPATH" "$CFP" 2>/dev/null; then
        ACC=$(printf '%s' "$ACC" | jq -c --argjson c "$CAND" '. + [$c]' 2>/dev/null || printf '%s' "$ACC")
      fi
    fi
    i=$((i+1))
  done
  FINAL_MATCHES="$ACC"
fi

MATCH_COUNT=$(printf '%s' "$FINAL_MATCHES" | jq 'length' 2>/dev/null || echo 0)
[ "$MATCH_COUNT" = "0" ] && exit 0

# 6. Build the nudge text. List up to 3 matches with URLs.
NUDGE_BODY=$(printf '%s' "$FINAL_MATCHES" | jq -r --arg host "$DOCO_BASE_URL" --arg doco_id "$DOCO_ID" --arg fp "$RELPATH" '
  .[0:3] | map(
    "- [" + (.slug // .id) + "](" + ($host) + "/by-id/" + ($doco_id) + "/decision/" + .id + ") (vector_score " + ((.vector_score // 0) | tostring) + "): " +
      (if (.summary | length) > 200 then (.summary[:197] + "...") else .summary end)
  ) | join("\n")
' 2>/dev/null)

[ -z "$NUDGE_BODY" ] && exit 0

NUDGE=$(printf '🔮 Doco PostToolUse — file just edited (%s) is referenced in an existing Decision\n\nThis edit touched **%s**. The following Decision(s) from this prompt'\''s search hits cite this path in their body (vector_score > 0.45):\n\n%s\n\n**Consider PATCHing one of these Decisions** instead of opening a sibling. Per ADR-141: if a high-vector_score hit already governs the change, PATCH it (`doco patch decision <id> --append-body "..."`) rather than skipping the capture or creating a near-duplicate. Two overlapping nodes are strictly worse than one stale one.' \
  "$RELPATH" "$RELPATH" "$NUDGE_BODY")

# 7. Emit the JSON envelope.
jq -nc --arg c "$NUDGE" \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $c}}'
