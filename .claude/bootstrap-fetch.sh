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
# valid JSON envelope with a fallback warning so the agent at least
# knows the canonical wasn't loaded and can curl it manually.
#
# Per the `agent-md-stays-a-pointer` Rule + the
# `claude-md-becomes-a-strong-bootstrap-stub` Decision (this commit).

set -u

# Load .env if DOCO_HOST isn't already in the shell env.
if [ -z "${DOCO_HOST:-}" ] && [ -f "$PWD/.env" ]; then
  # shellcheck disable=SC1091
  set -a
  source "$PWD/.env"
  set +a
fi
DOCO_HOST="${DOCO_HOST:-http://localhost:5173}"

emit_warning() {
  local msg=$1
  # Use printf so embedded quotes survive; let jq handle string escaping.
  if command -v jq >/dev/null 2>&1; then
    jq -nc --arg c "⚠️ Doco bootstrap not loaded: $msg. Read CLAUDE.md for the manual bootstrap procedure (curl \$DOCO_HOST/api/v1/agent-bootstrap)." \
      '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
  else
    # jq missing — emit a literal valid JSON. Escape only what matters.
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"⚠️ Doco bootstrap not loaded: %s. jq is also missing — install it or paste canonical_instructions manually."}}\n' \
      "$msg"
  fi
}

if ! command -v curl >/dev/null 2>&1; then
  emit_warning "curl is not installed"
  exit 0
fi

# Auth: bearer token if set, no auth otherwise (host returns 200 with the
# canonical_instructions even unauthenticated — token gates per-Doco context).
# Note: `set -u` makes empty arrays a tripwire when expanded inline, so we
# build the curl invocation as a single string and run it via `eval`.
AUTH_CURL=""
if [ -n "${DOCO_TOKEN:-}" ]; then
  AUTH_CURL="-H 'Authorization: Bearer ${DOCO_TOKEN}'"
fi

# Build the bootstrap URL with ?slug=<owner>/<doco> when DOCO_SLUG is set
# — the host returns a per-Doco code_map in the response when the slug is
# provided.
SLUG_PARAM=""
if [ -n "${DOCO_SLUG:-}" ]; then
  SLUG_PARAM="?slug=$(printf '%s' "$DOCO_SLUG" | jq -sRr @uri 2>/dev/null || printf '%s' "$DOCO_SLUG")"
fi

# ETag-aware fetch: cache the bootstrap response body + ETag, and on
# subsequent calls send `If-None-Match: <etag>`. The host returns 304
# (no body) when the cached version is still fresh, which we replay
# from the cache. Massively cheaper on long sessions because
# SessionStart fires on every clear/compact/resume — the canonical
# is 1k+ tokens and rarely changes between calls.
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/doco"
mkdir -p "$CACHE_DIR" 2>/dev/null || true
CACHE_KEY=$(printf '%s|%s' "$DOCO_HOST" "${DOCO_SLUG:-}" | shasum -a 256 2>/dev/null | cut -c1-16)
CACHE_BODY="$CACHE_DIR/bootstrap-$CACHE_KEY.json"
CACHE_ETAG="$CACHE_DIR/bootstrap-$CACHE_KEY.etag"

ETAG_CURL=""
if [ -f "$CACHE_ETAG" ]; then
  CACHED=$(cat "$CACHE_ETAG" 2>/dev/null)
  if [ -n "$CACHED" ]; then
    ETAG_CURL="-H 'If-None-Match: $CACHED'"
  fi
fi

RESP_BODY_FILE=$(mktemp 2>/dev/null || echo "/tmp/doco-bootstrap-resp.$$")
RESP_HEADER_FILE=$(mktemp 2>/dev/null || echo "/tmp/doco-bootstrap-hdr.$$")
HTTP_CODE=$(eval curl -s --max-time 8 -w '%{http_code}' -o "'$RESP_BODY_FILE'" -D "'$RESP_HEADER_FILE'" "$AUTH_CURL" "$ETAG_CURL" "'$DOCO_HOST/api/v1/agent-bootstrap${SLUG_PARAM}'" 2>/dev/null || printf '000')

RESP=""
if [ "$HTTP_CODE" = "304" ] && [ -f "$CACHE_BODY" ]; then
  RESP=$(cat "$CACHE_BODY" 2>/dev/null || true)
elif [ "$HTTP_CODE" = "200" ]; then
  RESP=$(cat "$RESP_BODY_FILE" 2>/dev/null || true)
  NEW_ETAG=$(grep -i '^etag:' "$RESP_HEADER_FILE" 2>/dev/null | tail -1 | sed -E 's/^[Ee][Tt][Aa][Gg]:[[:space:]]*//' | tr -d '\r\n')
  if [ -n "$NEW_ETAG" ] && [ -n "$RESP" ]; then
    printf '%s' "$RESP" > "$CACHE_BODY" 2>/dev/null || true
    printf '%s' "$NEW_ETAG" > "$CACHE_ETAG" 2>/dev/null || true
  fi
fi
rm -f "$RESP_BODY_FILE" "$RESP_HEADER_FILE"

if [ -z "$RESP" ]; then
  emit_warning "could not reach $DOCO_HOST/api/v1/agent-bootstrap (server down? wrong DOCO_HOST?)"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  # No jq — surface the raw response. Crude but always works.
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}\n' \
    "$(printf '%s' "$RESP" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')"
  exit 0
fi

INSTR=$(printf '%s' "$RESP" | jq -r '.canonical_instructions // empty')
if [ -z "$INSTR" ]; then
  emit_warning "bootstrap response has no canonical_instructions field"
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

# Surface the host's `warning` field when present — bootstrap may
# return a warning even on a 200 (e.g. slug is an alias and the agent
# should update .env, or the bearer can't access the Doco). The warning
# block goes near the top of the canonical so the agent sees it before
# the protocol details and surfaces it to the user.
WARNING_BLOCK=""
WARNING_TEXT=$(printf '%s' "$RESP" | jq -r '.warning // empty' 2>/dev/null)
if [ -n "$WARNING_TEXT" ]; then
  WARNING_BLOCK=$(printf '\n\n---\n\n## ⚠️ Bootstrap warning\n\n%s\n\nThis is not a hard failure — the canonical instructions below are still authoritative. But the per-Doco context (scopes / constitution) was not loaded, so any captures will need correcting once `.env` is fixed. Mention this to the user on your first reply.\n' "$WARNING_TEXT")
fi

# Pre-build the session-load indicator. Per canonical section 1a, the
# loading-verb line fires ONCE per session — at the moment the agent
# loads this canonical — separately from the per-query indicator. We
# pick the verb at random here so the agent doesn't have to, and
# instruct it to render the line on its first reply.
LOADING_VERBS=("Connected to" "Tuned into" "Listening to" "Wired up to" "Synced with" "Plugged into" "Online with" "Reading" "Hooked into" "Linked to" "Eyes on" "Riding shotgun on" "Pinned to" "Threaded into" "Locked onto" "Channel open:" "Live on" "Mind-melded with" "Pulled up" "Holding the file on")
LOADING_VERB="${LOADING_VERBS[$RANDOM % ${#LOADING_VERBS[@]}]}"
SESSION_LOAD_BLOCK=""
if [ -n "${DOCO_SLUG:-}" ]; then
  SESSION_LOAD_BLOCK=$(printf '\n\n---\n\n## Session-load indicator — emit on your FIRST reply only\n\nPer canonical section 1a, the moment of loading this canonical deserves its own line. Render this ABOVE your first reply\047s per-query indicator, then NEVER again in this session:\n\n```\n[🔮 Doco] %s %s\n```\n\nThe verb is already randomized — emit verbatim, don\047t re-pick.\n' "$LOADING_VERB" "$DOCO_SLUG")
fi

# Prepend a strong "do not re-fetch" header so the agent recognises the
# canonical is ALREADY in their context. The previous "if you see this,
# the hook worked" wording was too soft — agents re-fetched anyway. This
# version explicitly forbids re-fetching.
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HEADER=$'🔒 Doco canonical_instructions — auto-loaded by SessionStart hook at '"${TIMESTAMP}"$'\n\nThis IS the canonical. **Do NOT re-fetch via `curl $DOCO_HOST/api/v1/agent-bootstrap`** — re-read the block below instead. The protocol applies to every reply (query indicator at top, footer_lines after writes, tally at end). For deep reference (model walkthrough, scope onboarding, placement examples), the long form is at `/api/v1/agent-reference` — fetch only on demand.\n\n---\n\n'
printf '%s' "$RESP" | jq -nc --arg c "${HEADER}${INSTR}${WARNING_BLOCK}${CODE_MAP_BLOCK}${CONSTITUTION_BLOCK}${SCOPES_BLOCK}${SESSION_LOAD_BLOCK}" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $c}}'
