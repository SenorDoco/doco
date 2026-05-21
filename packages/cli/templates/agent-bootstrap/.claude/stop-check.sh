#!/usr/bin/env bash
# Stop hook: fires when the assistant finishes a turn. Parses the
# session transcript to count Edit/Write tool calls, Doco write commands,
# and user-facing Doco operation footers. It injects a final nudge for
# either of the two common drift cases:
#
# - edits happened but no Doco capture/patch/write was attempted;
# - Doco writes returned footer_lines, but the agent never pasted every
#   footer line into user-facing text.
#
# Wired from `.claude/settings.json`. Hook input (JSON on stdin) carries:
#   .hook_event_name = "Stop"
#   .transcript_path = "/Users/.../.claude/projects/.../<session-id>.jsonl"
#   .session_id, .cwd, .permission_mode, .effort
#
# Hook output is the JSON envelope:
#   { "hookSpecificOutput": { "hookEventName": "Stop",
#                             "additionalContext": "<nudge text>" } }
#
# Per ADR-141 (decision_01KRK9P1FPF5ZAPJ4DXAKPXYFJ), item 9: catch the
# agent who edited code, drifted from canonical, and was about to
# declare done without any capture.
#
# Soft nudge — never blocks the response. The agent already finished;
# this just prepends one more reminder before the user sees the reply.
# Silent exit 0 on every failure path.

set -u

# 1. Read hook input.
INPUT=$(cat 2>/dev/null || true)
if [ -z "$INPUT" ] || ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || true)
[ -z "$TRANSCRIPT" ] && exit 0
[ -f "$TRANSCRIPT" ] || exit 0

# Loop-guard: when the Stop hook fires and emits additionalContext, the
# agent may choose to continue (e.g. to capture or paste footers). If our last nudge is
# still the latest user-message-shaped entry in the transcript, we've
# already nudged this stretch — bail out to avoid double-nudging.
if grep -q "Doco Stop nudge —" "$TRANSCRIPT" 2>/dev/null; then
  # Already nudged. Only nudge again if a new Edit/Write/Bash came AFTER the
  # nudge line. Cheap check: look at the last 100 lines of the transcript.
  LAST_CHUNK=$(tail -c 200000 "$TRANSCRIPT" 2>/dev/null || true)
  NUDGE_LINE=$(printf '%s\n' "$LAST_CHUNK" | grep -n "Doco Stop nudge —" | tail -1 | cut -d: -f1)
  if [ -n "$NUDGE_LINE" ]; then
    AFTER_NUDGE=$(printf '%s\n' "$LAST_CHUNK" | tail -n "+$NUDGE_LINE")
    if ! printf '%s' "$AFTER_NUDGE" | grep -qE '"name":"(Edit|Write|MultiEdit|NotebookEdit|Bash)"'; then
      exit 0
    fi
  fi
fi

# 2. Parse the current turn's tool-use events. "Current turn" = since
#    the LAST user message in the transcript. Walk back from EOF until
#    we hit a user role; everything after is this turn.
#
#    Transcript is JSONL — one event per line. Assistant tool calls
#    appear as type=assistant with message.content[].type=tool_use
#    objects carrying .name and .input.
#
#    We count Edit/Write/MultiEdit/NotebookEdit calls in tool_name, Doco
#    write commands in Bash tool calls, footer lines printed by tools,
#    and footer lines pasted into assistant text. The critical check is
#    tool footer_lines > assistant footer_lines: the write succeeded, but
#    the client never got the per-operation update.

# Use python3 — it's preinstalled on macOS / most Linux and avoids the
# multi-line jq+awk gymnastics. Falls back silently if python3 missing.
if ! command -v python3 >/dev/null 2>&1; then
  exit 0
fi

COUNTS=$(python3 - "$TRANSCRIPT" <<'PYEOF' 2>/dev/null || true
import json, sys, re

path = sys.argv[1]
edits = 0
doco_writes = 0
assistant_footer_lines = 0
tool_footer_lines = 0

FOOTER_RE = re.compile(
    r'\[(?:🔮|✅) Doco\]\s*(?:✍️|📝|🧹|➕|➖|🔁|🏷️|🗑️)\s+'
)

def text_from(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(text_from(item.get('text') or item.get('content') or ''))
        return '\n'.join(parts)
    return ''

def count_footer_lines(text):
    return len(FOOTER_RE.findall(text or ''))

with open(path, 'r', encoding='utf-8', errors='replace') as f:
    lines = f.readlines()

# Find index of the most recent user-message event. Skip queue-operation
# entries (which are just transcript bookkeeping).
last_user_idx = -1
for i, line in enumerate(lines):
    try:
        d = json.loads(line)
    except Exception:
        continue
    if d.get('type') == 'user' and d.get('message', {}).get('role') == 'user':
        # Skip tool_result-shaped user messages (those are assistant's
        # tool outputs being fed back, not a fresh user prompt).
        content = d.get('message', {}).get('content')
        if isinstance(content, str):
            last_user_idx = i
        elif isinstance(content, list):
            has_text = any(
                isinstance(c, dict) and c.get('type') == 'text'
                for c in content
            )
            has_only_tool_results = all(
                isinstance(c, dict) and c.get('type') == 'tool_result'
                for c in content
            ) if content else False
            if has_text or not has_only_tool_results:
                last_user_idx = i

# Scan events AFTER the last user message.
for line in lines[last_user_idx + 1:]:
    try:
        d = json.loads(line)
    except Exception:
        continue
    content = d.get('message', {}).get('content', [])
    if isinstance(content, str):
        if d.get('type') == 'assistant':
            assistant_footer_lines += count_footer_lines(content)
        continue
    if not isinstance(content, list):
        continue
    for c in content:
        if not isinstance(c, dict):
            continue
        if d.get('type') == 'assistant' and c.get('type') == 'tool_use':
            name = c.get('name', '')
            inp = c.get('input', {}) or {}
            if name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
                edits += 1
            elif name == 'Bash':
                cmd = inp.get('command', '') or ''
                # Match CLI write surfaces and raw HTTP writes to capture
                # endpoints.
                if re.search(r'\bdoco\s+(capture|patch|supersede)\b', cmd):
                    doco_writes += 1
                elif re.search(r'curl[^|;&]*-X\s*(POST|PATCH|DELETE)[^|;&]*/api/[a-z]+(?:/\S*)?\.json', cmd, re.IGNORECASE):
                    doco_writes += 1
                elif re.search(r'curl[^|;&]*/api/[a-z]+(?:/\S*)?\.json[^|;&]*-X\s*(POST|PATCH|DELETE)', cmd, re.IGNORECASE):
                    doco_writes += 1
        elif d.get('type') == 'assistant' and c.get('type') == 'text':
            assistant_footer_lines += count_footer_lines(c.get('text', '') or '')
        elif d.get('type') == 'user' and c.get('type') == 'tool_result':
            tool_footer_lines += count_footer_lines(text_from(c.get('content', '')))

print(f"{edits} {doco_writes} {assistant_footer_lines} {tool_footer_lines}")
PYEOF
)

EDITS=$(printf '%s' "$COUNTS" | awk '{print $1}')
DOCO_WRITES=$(printf '%s' "$COUNTS" | awk '{print $2}')
ASSISTANT_FOOTERS=$(printf '%s' "$COUNTS" | awk '{print $3}')
TOOL_FOOTERS=$(printf '%s' "$COUNTS" | awk '{print $4}')
EDITS="${EDITS:-0}"
DOCO_WRITES="${DOCO_WRITES:-0}"
ASSISTANT_FOOTERS="${ASSISTANT_FOOTERS:-0}"
TOOL_FOOTERS="${TOOL_FOOTERS:-0}"

# 3a. Doco wrote nodes, but the assistant didn't paste every returned
#     footer line into user-facing text.
if [ "$TOOL_FOOTERS" -gt "$ASSISTANT_FOOTERS" ] 2>/dev/null; then
  NUDGE=$(printf '🔮 Doco Stop nudge — Doco write footer_lines not shown to user\n\nThis turn'\''s Doco write tool output contained %s footer line(s), but assistant text emitted %s. The closing tally is not a substitute for per-operation updates.\n\nBefore declaring done, paste every returned `footer_lines` entry verbatim, one per line, above the final tally. If multiple nodes were added or updated, the user should see one Doco operation line for each returned footer line.' \
    "$TOOL_FOOTERS" "$ASSISTANT_FOOTERS")

  jq -nc --arg c "$NUDGE" \
    '{hookSpecificOutput: {hookEventName: "Stop", additionalContext: $c}}'
  exit 0
fi

# 3b. Existing ADR-141 nudge: edits happened, but no Doco write signal.
if [ "$EDITS" = "0" ] || [ "$DOCO_WRITES" != "0" ] || [ "$ASSISTANT_FOOTERS" != "0" ]; then
  exit 0
fi

NUDGE=$(printf '🔮 Doco Stop nudge — turn had edits but no captures\n\nThis turn made %s Edit/Write tool call(s) but no Doco capture call was detected and no footer-line was emitted. Before declaring done:\n\n1. **Name the existing node you'\''re relying on.** If a Decision, Rule, or Action already covers what you changed, the capture obligation is satisfied — but say *which* node. "Too small for a Decision" is not naming a node.\n2. **If no node fits**, capture one now with `doco capture decision ...` (or PATCH an existing entity via `doco patch <type> <id> --append-body ...`). One short Decision beats a months-from-now archaeology dig through `git log`.\n3. The Stop hook reminded you. Suppress this nudge by either capturing or by stating the node-name you'\''re relying on in your final summary.' \
  "$EDITS")

jq -nc --arg c "$NUDGE" \
  '{hookSpecificOutput: {hookEventName: "Stop", additionalContext: $c}}'
