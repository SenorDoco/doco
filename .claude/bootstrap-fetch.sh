#!/usr/bin/env bash
# SessionStart hook: fetch this Doco's bootstrap (canonical instructions
# + scopes + recent activity) and inject `canonical_instructions` into
# the agent's context.
#
# Wired from `.claude/settings.json`. Output is the JSON envelope Claude
# Code's hook runner expects:
#   { "hookSpecificOutput": { "hookEventName": "SessionStart",
#                             "additionalContext": "<text>" } }
#
# On failure (host unreachable, env missing, jq/node absent) we still emit a
# valid JSON envelope with a disconnected indicator so the agent never
# presents as connected without proper access.

set -u

# Load .env if present. The only secret env var Doco needs is
# DOCO_ACCESS. The project coordinate lives in doco.md, and bound
# credentials let the bootstrap endpoint infer it.
if [ -f "$PWD/.env" ]; then
  # shellcheck disable=SC1091
  set -a
  source "$PWD/.env"
  set +a
fi

emit_disconnected() {
  # $1 indicator_reason — single-line "Not connected yet: <reason>" reason
  # $2 mode             — picks the recovery suffix; defaults to "default"
  # $3 body_extra       — optional multi-line content inserted between
  #                       the indicator and the recovery
  #
  # Recovery mode never bakes "re-onboard" into a sandbox-block case —
  # the access URL is fine, the request just didn't leave the runtime.
  #   default  — credentials issue, re-onboard via the browser flow
  #   network  — sandbox / network policy, allowlist doco.to
  #   tool     — missing local tool (curl / jq); install it
  #   verbatim — body_extra is authoritative; no generic suffix
  local indicator_reason=$1
  local mode=${2:-default}
  local body_extra=${3:-}
  local recovery
  case "$mode" in
    network)
      recovery=$'**This is a sandbox / network-policy issue, not a credentials problem — re-onboarding will NOT help.** The access credential is fine; the bootstrap request didn\'t leave your agent runtime. Recovery depends on which runtime you\'re in:\n\n- **Codex Desktop**: the allowlist IS the approval prompt. When Codex asks to allow network access, click Allow and choose the persistent option. The safe prefix to persist is the exact helper path: `node .agents/doco-agent-client.mjs`. DO NOT approve broader `node` — that grants any Node script network access.\n- **Codex Web / GitHub Coding Agent / Anthropic web sandbox**: each has its own Environment access → Network access (or equivalent) settings page. Add `doco.to` to the allowlist there.\n- **Generic**: allow outbound HTTPS to `doco.to` on port 443.\n\nOnce the host is reachable, restart or `/clear` so SessionStart runs again.'
      ;;
    tool)
      recovery=$'Install the missing local tool, then restart or `/clear` so SessionStart runs again.'
      ;;
    verbatim)
      recovery=""
      ;;
    default|*)
      recovery=$'Ask the project owner for an invite URL or re-onboard the agent at https://doco.to/onboarding/create/agent.txt. Write the returned access credential into ./.env as DOCO_ACCESS. After that, restart or `/clear` so SessionStart runs again.'
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
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[🔮 Doco] Not connected yet: %s. jq is also missing — install it before retrying."}}\n' \
      "$indicator_reason"
  fi
}

if ! command -v node >/dev/null 2>&1; then
  emit_disconnected "node is not installed" tool
  exit 0
fi

CLIENT="$PWD/.agents/doco-agent-client.mjs"
if [ ! -f "$CLIENT" ]; then
  emit_disconnected "Doco agent client is missing at .agents/doco-agent-client.mjs" tool
  exit 0
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

if [ -z "${DOCO_ACCESS:-}" ]; then
  emit_disconnected "missing DOCO_ACCESS — ask the project owner for an invite URL (or create a new Doco via POST https://doco.to/api/v1/docos.json)" default
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  emit_disconnected "jq is not installed" tool
  exit 0
fi

BOOT_META=$(node "$CLIENT" bootstrap --meta 2>/dev/null || true)
if [ -z "$BOOT_META" ]; then
  emit_disconnected "doco.to unreachable (HTTP_STATUS:000 / network blocked at the agent runtime)" network
  exit 0
fi
if ! printf '%s' "$BOOT_META" | jq -e . >/dev/null 2>&1; then
  emit_disconnected "bootstrap helper returned invalid JSON" default
  exit 0
fi

HTTP_STATUS=$(printf '%s' "$BOOT_META" | jq -r '.status // 0' 2>/dev/null)
BOOT_CODE=$(printf '%s' "$BOOT_META" | jq -r '.code // empty' 2>/dev/null)
BOOT_ERROR=$(printf '%s' "$BOOT_META" | jq -r '.error // empty' 2>/dev/null)
RESP=$(printf '%s' "$BOOT_META" | jq -c '.body // empty' 2>/dev/null)
if [ "$BOOT_CODE" = "missing_access" ]; then
  emit_disconnected "missing DOCO_ACCESS — ask the project owner for an invite URL (or create a new Doco via POST https://doco.to/api/v1/docos.json)" default
  exit 0
fi
if [ "$BOOT_CODE" = "network" ] || [ "$BOOT_CODE" = "timeout" ] || [ "$HTTP_STATUS" = "0" ]; then
  emit_disconnected "doco.to unreachable (HTTP_STATUS:000 / network blocked at the agent runtime)" network
  exit 0
fi
if [ "$HTTP_STATUS" != "200" ]; then
  case "$HTTP_STATUS" in
    401) emit_disconnected "DOCO_ACCESS invalid or revoked (HTTP 401) — ask for a fresh invite URL" default ;;
    403) emit_disconnected "DOCO_ACCESS cannot reach this Doco (HTTP 403)" default ;;
    404) emit_disconnected "Doco not found for this DOCO_ACCESS (HTTP 404)" default ;;
    5*) emit_disconnected "doco.to returned ${HTTP_STATUS} — host outage; wait and retry." network ;;
    *) emit_disconnected "${BOOT_ERROR:-bootstrap failed with HTTP ${HTTP_STATUS}}" default ;;
  esac
  exit 0
fi

INSTR=$(printf '%s' "$RESP" | jq -r '.canonical_instructions // empty')
if [ -z "$INSTR" ]; then
  emit_disconnected "bootstrap response has no canonical_instructions field"
  exit 0
fi

WARNING_TEXT=$(printf '%s' "$RESP" | jq -r '.warning // empty' 2>/dev/null)
HAS_GUIDANCE=$(printf '%s' "$RESP" | jq -r '.missing_doco_guidance // empty | if type == "object" then "1" else "" end' 2>/dev/null)
RESP_DOCO=$(printf '%s' "$RESP" | jq -r '.doco_handle // .doco_slug // empty' 2>/dev/null)

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

# Pre-bake the session-load indicator block.
LOADING_VERBS=("Connected to" "Tuned into" "Listening to" "Wired up to" "Synced with" "Plugged into" "Online with" "Reading" "Hooked into" "Eyes on" "Riding shotgun on" "Pinned to" "Threaded into" "Locked onto" "Channel open:" "Live on" "Mind-melded with" "Pulled up" "Holding the file on")
LOADING_VERB="${LOADING_VERBS[$RANDOM % ${#LOADING_VERBS[@]}]}"
if [ -n "$RESP_DOCO" ]; then
  DOCO_FOR_LINE="${RESP_DOCO}"
else
  DOCO_FOR_LINE="this Doco"
fi
SESSION_LOAD_LINE="[🔮 Doco] ${LOADING_VERB} ${DOCO_FOR_LINE}"
SESSION_LOAD_HINT='[🔮 Doco] To document anything, just ask me to "doco it"'
SESSION_LOAD_BLOCK="    ${SESSION_LOAD_LINE}"$'\n'"    ${SESSION_LOAD_HINT}"

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
    SCOPES_BLOCK=$(printf '\n\n---\n\n## scopes — this Doco\047s topical neighborhoods\n\nEvery captured node must list at least one scope. Mandatory scopes apply to ALL nodes; optional scopes are picked by what the node is about.\n\n%s\n' "$SCOPES_TEXT")
  fi
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HEADER=$'🔒 Doco canonical_instructions — auto-loaded by SessionStart hook at '"${TIMESTAMP}"$'\n\n⚠️ **The literal first lines of your first reply must be the session-load block** — emitted BEFORE any prose, narration, or tool calls. Pre-built for you here (verb already randomized — paste verbatim):\n\n'"${SESSION_LOAD_BLOCK}"$'\n\nNo "let me read this first" preface. No "I see this repo has Doco" prose. The block IS the acknowledgement. Then your per-reply [🔮 Doco] querying / count lines, then prose. See canonical § 1a below.\n\nThis IS the canonical. **Do NOT re-fetch via raw curl** — re-read the block below instead. The protocol applies to every connected reply (query indicator at top, footer_lines after writes, tally at end). For deep reference (model walkthrough, scope onboarding, placement examples), the long form is at `https://doco.to/api/v1/agent-reference` — fetch only on demand.\n\n---\n\n'
printf '%s' "$RESP" | jq -nc --arg c "${HEADER}${INSTR}${CONSTITUTION_BLOCK}${SCOPES_BLOCK}" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
