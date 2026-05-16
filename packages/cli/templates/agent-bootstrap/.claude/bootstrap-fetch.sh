#!/usr/bin/env bash
# SessionStart hook: fetch the Doco host's agent-bootstrap and inject
# `canonical_instructions` into the agent's context.
#
# Wired from `.claude/settings.json`. Output is the JSON envelope Claude
# Code's hook runner expects:
#   { "hookSpecificOutput": { "hookEventName": "SessionStart",
#                             "additionalContext": "<text>" } }
#
# On failure (host unreachable, env missing, jq absent) we still emit a
# valid JSON envelope with a disconnected indicator so the agent never
# presents as connected without proper access.
#
# Per the `agent-md-stays-a-pointer` Rule + the
# `claude-md-becomes-a-strong-bootstrap-stub` Decision (this commit).

set -u

# Load .env if present. The production host is fixed at doco.to; env
# only carries the DOCO_TOKEN secret. DOCO_ID lives in AGENTS.md
# (committed, non-secret) — we read it from there if it's not already
# in env. Legacy repos with DOCO_ID in .env keep working: env wins
# over the AGENTS.md fallback.
if [ -f "$PWD/.env" ]; then
  # shellcheck disable=SC1091
  set -a
  source "$PWD/.env"
  set +a
fi
if [ -z "${DOCO_ID:-}" ]; then
  for f in "$PWD/AGENTS.md" "$PWD/CLAUDE.md"; do
    if [ -f "$f" ]; then
      DOCO_ID=$(grep -oE 'doco_[A-Za-z0-9]+' "$f" | head -1)
      [ -n "$DOCO_ID" ] && export DOCO_ID && break
    fi
  done
fi
DOCO_BASE_URL="https://doco.to"

emit_disconnected() {
  # $1 indicator_reason — single-line "Not connected yet: <reason>" reason
  # $2 mode             — picks the recovery suffix (see below); defaults to "default"
  # $3 body_extra       — optional multi-line content inserted between
  #                       the indicator and the recovery (e.g. the host's
  #                       structured missing_doco_guidance actions)
  #
  # Recovery mode never bakes `doco login` into a sandbox-block case —
  # the token is fine, the request just didn't leave the runtime.
  #   default  — credentials issue, do `doco login` to re-authorize
  #   network  — sandbox / network policy, allowlist doco.to in the agent runtime
  #   tool     — missing local tool (curl / jq); install it
  #   verbatim — body_extra is authoritative; no generic suffix
  local indicator_reason=$1
  local mode=${2:-default}
  local body_extra=${3:-}
  local recovery
  case "$mode" in
    network)
      recovery=$'**This is a sandbox / network-policy issue, not a credentials problem — `doco login` will NOT help.** The bearer token is fine; the bootstrap request didn\'t leave your agent runtime. Tell the project owner to allowlist `doco.to` in your agent\'s network settings (Codex web, GitHub Coding Agent, Anthropic web sandbox, etc. each have their own settings page). For a one-off, they may also approve the call inline in the agent\'s UI. Once the host is reachable, restart or `/clear` so SessionStart runs again.'
      ;;
    tool)
      recovery=$'Install the missing local tool, then restart or `/clear` so SessionStart runs again.'
      ;;
    verbatim)
      recovery=""
      ;;
    default|*)
      recovery=$'Ask the project owner to authorize the agent with `doco login --host https://doco.to` (or `doco login --host https://doco.to --create <slug>` for a new Doco), then restart or `/clear` so SessionStart runs again.'
      ;;
  esac
  local body
  body=$'🔒 Doco connection — not connected\n\n⚠️ **Every reply must start with this exact line until access is fixed:**\n\n    [🔮 Doco] Not connected yet: '"${indicator_reason}"$'\n\nDo not render regular Doco query/count/footer/tally lines while disconnected.'
  if [ -n "$body_extra" ]; then
    body="${body}"$'\n\n'"${body_extra}"
  fi
  if [ -n "$recovery" ]; then
    body="${body}"$'\n\n'"${recovery}"
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -nc --arg c "$body" \
      '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
  else
    # jq missing — emit a literal valid JSON. Escape only what matters.
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[🔮 Doco] Not connected yet: %s. jq is also missing — install it before retrying."}}\n' \
      "$indicator_reason"
  fi
}

if ! command -v curl >/dev/null 2>&1; then
  emit_disconnected "curl is not installed" tool
  exit 0
fi
if [ -z "${DOCO_ID:-}" ]; then
  emit_disconnected "missing DOCO_ID — set the **This project's Doco ID** line at the top of AGENTS.md, or run \`doco login --host https://doco.to\` to stamp it" default
  exit 0
fi
if [ -z "${DOCO_TOKEN:-}" ]; then
  emit_disconnected "missing DOCO_TOKEN" default
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  emit_disconnected "jq is not installed" tool
  exit 0
fi

DOCO_PARAM="?id=$(printf '%s' "$DOCO_ID" | jq -sRr @uri 2>/dev/null || printf '%s' "$DOCO_ID")"
TMP_RESP="${TMPDIR:-/tmp}/doco-bootstrap-$$.json"
HTTP_STATUS=$(curl -sS --max-time 8 -w '%{http_code}' -o "$TMP_RESP" \
  -H "Authorization: Bearer ${DOCO_TOKEN}" \
  "${DOCO_BASE_URL}/api/v1/agent-bootstrap${DOCO_PARAM}" 2>/dev/null || true)
RESP=$(cat "$TMP_RESP" 2>/dev/null || true)
rm -f "$TMP_RESP" 2>/dev/null || true
if [ -z "$RESP" ]; then
  # Empty body OR curl exit non-zero means the request never reached
  # the host (DNS, sandbox network gate, firewall). HTTP_STATUS:000 is
  # the same case. Don't tell the project owner to `doco login` — the
  # token is fine; the runtime is the blocker.
  emit_disconnected "doco.to unreachable (HTTP_STATUS:000 / network blocked at the agent runtime)" network
  exit 0
fi
if [ "$HTTP_STATUS" != "200" ]; then
  case "$HTTP_STATUS" in
    401) emit_disconnected "DOCO_TOKEN expired or invalid (HTTP 401)" default ;;
    403) emit_disconnected "token cannot access this Doco (HTTP 403) — ask the project owner to add this agent as a member, or run \`doco login\` with an account that already has access. Don't run \`--create\` — there's already a Doco; you just can't reach it." default ;;
    404) emit_disconnected "DOCO_ID \"${DOCO_ID}\" doesn't resolve on doco.to (HTTP 404)" default ;;
    5*) emit_disconnected "doco.to returned ${HTTP_STATUS} — host outage; wait and retry. \`doco login\` won't help." network ;;
    *) emit_disconnected "bootstrap failed with HTTP ${HTTP_STATUS}" default ;;
  esac
  exit 0
fi

INSTR=$(printf '%s' "$RESP" | jq -r '.canonical_instructions // empty')
if [ -z "$INSTR" ]; then
  emit_disconnected "bootstrap response has no canonical_instructions field"
  exit 0
fi

WARNING_TEXT=$(printf '%s' "$RESP" | jq -r '.warning // empty' 2>/dev/null)
RESP_DOCO_ID=$(printf '%s' "$RESP" | jq -r '.doco_id // empty' 2>/dev/null)
HAS_GUIDANCE=$(printf '%s' "$RESP" | jq -r '.missing_doco_guidance // empty | if type == "object" then "1" else "" end' 2>/dev/null)

# When the host says the DOCO_ID didn't resolve OR resolved-but-is-
# inaccessible, the bootstrap response carries structured recovery
# guidance under `missing_doco_guidance` plus a single-line summary
# under `warning`. Split title (indicator) from summary+actions (body)
# so the agent sees a clean "Not connected yet: <title>" line plus the
# numbered action list — instead of cramming the whole multi-paragraph
# guidance into the indicator slot.
if [ -n "$HAS_GUIDANCE" ]; then
  GUIDANCE_TITLE=$(printf '%s' "$RESP" | jq -r '.missing_doco_guidance.title // empty' 2>/dev/null)
  GUIDANCE_BODY=$(printf '%s' "$RESP" | jq -r '
    .missing_doco_guidance as $g |
    $g.summary + "\n\n"
    + (
        ($g.actions | to_entries | map(
          ((.key + 1) | tostring) + ". " + .value.label
          + (if .value.command then "\n     $ " + .value.command else "" end)
          + "\n     " + .value.explainer
        )) | join("\n\n")
      )
  ' 2>/dev/null)
  emit_disconnected "$GUIDANCE_TITLE" verbatim "$GUIDANCE_BODY"
  exit 0
fi
if [ -n "$WARNING_TEXT" ]; then
  emit_disconnected "$WARNING_TEXT" verbatim
  exit 0
fi
if [ "$RESP_DOCO_ID" != "$DOCO_ID" ]; then
  emit_disconnected "bootstrap did not return context for ${DOCO_ID}" default
  exit 0
fi

# Include the per-Doco code_map when the host returned one. Stringified
# as YAML-ish nested list under a clear header so the agent recognises it.
CODE_MAP_BLOCK=""
if printf '%s' "$RESP" | jq -e '.code_map and (.code_map | type == "object")' >/dev/null 2>&1; then
  CODE_MAP_TEXT=$(printf '%s' "$RESP" | jq -r '
    .code_map as $cm |
    ($cm | keys[]) as $k |
    "### " + $k + "\n" + (($cm[$k] | if type == "array" then map("- " + .) | join("\n") else "- " + tostring end))
  ' 2>/dev/null)
  if [ -n "$CODE_MAP_TEXT" ]; then
    CODE_MAP_BLOCK=$(printf '\n\n---\n\n## code_map — where each feature\047s code lives\n\nSaves you a filesystem grep. Read these paths first when the user\047s task hits one of the listed features.\n\n%s\n' "$CODE_MAP_TEXT")
  fi
fi

# Include the Constitution scope when the host returned one. The
# Constitution holds Doco-wide rules that block captures at the server
# boundary — surfacing it here means the agent sees what'll trip a
# 400 *before* drafting an entity, not after.
CONSTITUTION_BLOCK=""
if printf '%s' "$RESP" | jq -e '.constitution and (.constitution | type == "object")' >/dev/null 2>&1; then
  CONSTITUTION_TEXT=$(printf '%s' "$RESP" | jq -r '
    .constitution as $c |
    "**Scope:** " + ($c.icon // "⚖️") + " `" + $c.name + "` (id: `" + $c.id + "`)\n\n"
    + (if ($c.purpose // "") != "" then "**Purpose:** " + $c.purpose + "\n\n" else "" end)
    + (if ($c.guidelines // "") != "" then "**Guidelines:**\n\n" + $c.guidelines + "\n\n" else "" end)
    + (if (($c.rules // []) | length) > 0
        then "**Rules (capture aborts with 400 on a deterministic violation):**\n\n"
          + (($c.rules | map(
              if .kind == "requires_edge" then
                "- `requires_edge` " + .edge_type + (if .target_node_type then " → " + .target_node_type else "" end) + (if .reason then " — " + .reason else "" end)
              elif .kind == "forbids_edge" then
                "- `forbids_edge` " + .edge_type + (if .target_node_type then " → " + .target_node_type else "" end) + (if .reason then " — " + .reason else "" end)
              elif .kind == "requires_field" then
                "- `requires_field` `" + .field + "`" + (if .reason then " — " + .reason else "" end)
              elif .kind == "forbids_field" then
                "- `forbids_field` `" + .field + "`" + (if .reason then " — " + .reason else "" end)
              elif .kind == "mandatory_scope" then
                "- `mandatory_scope` → every node must list scope `" + .scope_id + "`" + (if .reason then " — " + .reason else "" end)
              elif .kind == "probabilistic" then
                "- `probabilistic` (LLM-judged) — " + (.spec // "")
              else
                "- `" + .kind + "`"
              end
            )) | join("\n"))
        else ""
        end)
  ' 2>/dev/null)
  if [ -n "$CONSTITUTION_TEXT" ]; then
    CONSTITUTION_BLOCK=$(printf '\n\n---\n\n## constitution — this Doco\047s load-bearing rules\n\nThese rules are enforced server-side at capture time. Read them BEFORE drafting a Decision/Rule/Intent so you don\047t draft something that\047ll trip a 400.\n\n%s\n' "$CONSTITUTION_TEXT")
  fi
fi

# Include the scopes manifest when the host returned one. Splits into
# mandatory (forced by the Constitution onto every node — capture aborts
# without them) and optional (pick by content). When the manifest is
# empty the block is suppressed entirely.
SCOPES_BLOCK=""
if printf '%s' "$RESP" | jq -e '.scopes and (.scopes | type == "array") and ((.scopes | length) > 0)' >/dev/null 2>&1; then
  SCOPES_TEXT=$(printf '%s' "$RESP" | jq -r '
    (.scopes | map(select(.is_mandatory == true))) as $mand |
    (.scopes | map(select(.is_mandatory != true))) as $opt |
    "### Mandatory — every node must list these (capture aborts without them)\n\n"
    + (if ($mand | length) > 0
        then (($mand | map(
            "- " + (.icon // "🏷️") + " `" + .name + "` — " + (.purpose // "(no purpose set)")
          )) | join("\n"))
        else "_(none in this Doco — no `mandatory_scope` rule on the Constitution)_"
        end)
    + "\n\n### Optional — pick by what the node is about\n\n"
    + (if ($opt | length) > 0
        then (($opt | map(
            "- " + (.icon // "🏷️") + " `" + .name + "` — " + (.purpose // "(no purpose set)")
              + (if .lifecycle == "deprecated" then " _(deprecated)_" else "" end)
          )) | join("\n"))
        else "_(none)_"
        end)
  ' 2>/dev/null)
  if [ -n "$SCOPES_TEXT" ]; then
    SCOPES_BLOCK=$(printf '\n\n---\n\n## scopes — this Doco\047s topical neighborhoods\n\nEvery captured node must list at least one scope. Mandatory scopes apply to ALL nodes; optional scopes are picked by what the node is about. Full guidelines: open the scope\047s page or fetch /status.json.\n\n%s\n' "$SCOPES_TEXT")
  fi
fi

# Pre-bake the session-load indicator block so the agent emits it as
# the literal first output of its first reply — BEFORE any prose,
# narration, or tool calls. Pick a random loading-verb from the
# canonical 1a list so the block is ready to paste verbatim.
LOADING_VERBS=("Connected to" "Tuned into" "Listening to" "Wired up to" "Synced with" "Plugged into" "Online with" "Reading" "Hooked into" "Eyes on" "Riding shotgun on" "Pinned to" "Threaded into" "Locked onto" "Channel open:" "Live on" "Mind-melded with" "Pulled up" "Holding the file on")
LOADING_VERB="${LOADING_VERBS[$RANDOM % ${#LOADING_VERBS[@]}]}"
DOCO_FOR_LINE="${DOCO_ID:-this Doco}"
SESSION_LOAD_LINE="[🔮 Doco] ${LOADING_VERB} ${DOCO_FOR_LINE}"
SESSION_LOAD_HINT='[🔮 Doco] To document anything, just ask me to "doco it"'
SESSION_LOAD_BLOCK="    ${SESSION_LOAD_LINE}"$'\n'"    ${SESSION_LOAD_HINT}"

# Prepend a strong "do not re-fetch" header so the agent recognises the
# canonical is ALREADY in their context. The previous "if you see this,
# the hook worked" wording was too soft — agents re-fetched anyway. This
# version explicitly forbids re-fetching AND pre-bakes the session-load
# block the agent must emit as its first output.
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HEADER=$'🔒 Doco canonical_instructions — auto-loaded by SessionStart hook at '"${TIMESTAMP}"$'\n\n⚠️ **The literal first lines of your first reply must be the session-load block** — emitted BEFORE any prose, narration, or tool calls. Pre-built for you here (verb already randomized — paste verbatim):\n\n'"${SESSION_LOAD_BLOCK}"$'\n\nNo "let me read this first" preface. No "I see this repo has Doco" prose. The block IS the acknowledgement. Then your per-reply [🔮 Doco] querying / count lines, then prose. See canonical § 1a below.\n\nThis IS the canonical. **Do NOT re-fetch via raw curl** — re-read the block below instead, or use `doco bootstrap` if this block has genuinely fallen out of context. The protocol applies to every connected reply (query indicator at top, footer_lines after writes, tally at end). For deep reference (model walkthrough, scope onboarding, placement examples), the long form is at `/api/v1/agent-reference` — fetch only on demand.\n\n---\n\n'
printf '%s' "$RESP" | jq -nc --arg c "${HEADER}${INSTR}${CODE_MAP_BLOCK}${CONSTITUTION_BLOCK}${SCOPES_BLOCK}" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
