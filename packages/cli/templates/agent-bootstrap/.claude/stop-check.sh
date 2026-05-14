#!/usr/bin/env bash
# Stop hook: fires when the assistant finishes a turn. Parses the
# session transcript to count Edit/Write tool calls vs. doco-capture
# Bash invocations. If edits > 0 and captures == 0, inject a final
# nudge reminding the agent that a turn with code changes but no
# Doco trail looks like a capture-skip.
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
# agent may choose to continue (e.g. to capture). If our last nudge is
# still the latest user-message-shaped entry in the transcript, we've
# already nudged this stretch — bail out to avoid double-nudging.
if grep -q "Doco Stop nudge — turn had edits but no captures" "$TRANSCRIPT" 2>/dev/null; then
  # Already nudged. Only nudge again if a new Edit/Write came AFTER the
  # nudge line. Cheap check: look at the last 100 lines of the transcript.
  LAST_CHUNK=$(tail -c 200000 "$TRANSCRIPT" 2>/dev/null || true)
  NUDGE_LINE=$(printf '%s\n' "$LAST_CHUNK" | grep -n "Doco Stop nudge — turn had edits but no captures" | tail -1 | cut -d: -f1)
  if [ -n "$NUDGE_LINE" ]; then
    AFTER_NUDGE=$(printf '%s\n' "$LAST_CHUNK" | tail -n "+$NUDGE_LINE")
    if ! printf '%s' "$AFTER_NUDGE" | grep -qE '"name":"(Edit|Write|MultiEdit|NotebookEdit)"'; then
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
#    We count Edit/Write/MultiEdit/NotebookEdit calls in tool_name, and
#    we count Bash calls whose .command starts with "doco capture" or
#    "doco patch" (the two CLI surfaces that write to Doco). We also
#    count occurrences of the "✍️ added" footer-line marker in
#    assistant text content — agents sometimes capture via raw curl and
#    paste the footer instead of using the CLI.

# Use python3 — it's preinstalled on macOS / most Linux and avoids the
# multi-line jq+awk gymnastics. Falls back silently if python3 missing.
if ! command -v python3 >/dev/null 2>&1; then
  exit 0
fi

COUNTS=$(python3 - "$TRANSCRIPT" <<'PYEOF' 2>/dev/null || true
import json, sys, re

path = sys.argv[1]
edits = 0
captures = 0
footer_lines = 0

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
    if d.get('type') != 'assistant':
        continue
    content = d.get('message', {}).get('content', [])
    if not isinstance(content, list):
        continue
    for c in content:
        if not isinstance(c, dict):
            continue
        if c.get('type') == 'tool_use':
            name = c.get('name', '')
            inp = c.get('input', {}) or {}
            if name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
                edits += 1
            elif name == 'Bash':
                cmd = inp.get('command', '') or ''
                # Match `doco capture …`, `doco patch …`, or curl POSTs
                # to /api/<type>.json endpoints.
                if re.search(r'\bdoco\s+(capture|patch)\b', cmd):
                    captures += 1
                elif re.search(r'curl[^|;&]*-X\s*(POST|PATCH)[^|;&]*/api/[a-z]+\.json', cmd, re.IGNORECASE):
                    captures += 1
                elif re.search(r'curl[^|;&]*/api/[a-z]+\.json[^|;&]*-X\s*(POST|PATCH)', cmd, re.IGNORECASE):
                    captures += 1
        elif c.get('type') == 'text':
            text = c.get('text', '') or ''
            # Footer-line markers: each doco-write op emits a line like
            # "[✅ Doco] ...: ✍️ Decision added: ..."
            footer_lines += text.count('✍️ ')
            footer_lines += text.count(': 📝 ')

# captures counts CLI/curl invocations; footer_lines is a fallback
# signal for agents that pasted footers (i.e. they DID capture, the CLI
# just wasn't via a Bash tool that lives in this transcript).
total_capture_signal = captures + (1 if footer_lines > 0 else 0)
print(f"{edits} {total_capture_signal}")
PYEOF
)

EDITS=$(printf '%s' "$COUNTS" | awk '{print $1}')
CAPTURES=$(printf '%s' "$COUNTS" | awk '{print $2}')
EDITS="${EDITS:-0}"
CAPTURES="${CAPTURES:-0}"

# 3. Nudge condition: edits > 0 AND captures == 0.
if [ "$EDITS" = "0" ] || [ "$CAPTURES" != "0" ]; then
  exit 0
fi

NUDGE=$(printf '🔮 Doco Stop nudge — turn had edits but no captures\n\nThis turn made %s Edit/Write tool call(s) but no `doco capture` / `doco patch` invocation and no footer-line was emitted. Before declaring done:\n\n1. **Name the existing node you'\''re relying on.** If a Decision, Rule, or Action already covers what you changed, the capture obligation is satisfied — but say *which* node. "CLI can'\''t capture Actions" or "too small for a Decision" are not naming a node.\n2. **If no node fits**, capture one now (`doco capture decision …`, `doco capture action …`, or `doco patch <type> <id> --append-body …` per ADR-141). One short Decision beats a months-from-now archaeology dig through `git log`.\n3. The Stop hook reminded you. Suppress this nudge by either capturing or by stating the node-name you'\''re relying on in your final summary.' \
  "$EDITS")

jq -nc --arg c "$NUDGE" \
  '{hookSpecificOutput: {hookEventName: "Stop", additionalContext: $c}}'
