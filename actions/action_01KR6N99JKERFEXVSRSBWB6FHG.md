---
id: action_01KR6N99JKERFEXVSRSBWB6FHG
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 10.1 — DOCO_PUBLIC_HOST env var. Override the host portion of all shareable URLs (invitation, claim, copyable messages) so off-machine agents can reach the dev server through ngrok or similar."

actor_id: claude-opus-4-7
verb: ship_public_host_override

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6KS73P659EVRVF73EW823F   # ADR-073 — onboarding wizard
  - decision_01KR6HJABS6GYHR9DXP4DZVRHR   # ADR-071 — flagged localhost as objection #3

inputs:
  user_observation: |
    A receiving Claude Code session in another repo couldn't fetch the
    onboarding URL: "ECONNREFUSED ... 127.0.0.1:5173 is your machine,
    not a service I can reach." Localhost works for same-machine
    browser access; not for off-machine or off-session agents.
  user_choice: |
    From three paths (A=human-driven flow, B=public-host override,
    C=hosted deploy), the user picked B.

outputs:
  source_files_changed:
    - packages/web/app/lib/public-url.ts                     # NEW — getPublicBaseUrl(request) helper
    - packages/web/app/routes/invite.tsx                     # action — invite URL
    - packages/web/app/routes/onboarding.create.human.tsx    # loader — copyable message URL
    - packages/web/app/routes/onboarding.join.human.tsx      # loader — copyable message URL
    - packages/web/app/routes/onboarding.create.agent.tsx    # loader + action — doco URL, claim URL, redeem URL
    - packages/web/app/routes/invite.$token.tsx              # loader — manifest baseUrl
    - packages/web/app/routes/invite.$token[.]json.tsx       # loader + action — manifest baseUrl
    - packages/index/src/__tests__/build.test.ts             # bumped action count
  helper_resolution_order:
    - "1. DOCO_PUBLIC_HOST env var, if set. Strips trailing slash."
    - "2. Falls back to ${request.url.protocol}//${request.url.host}."
  e2e_verified:
    - "Set DOCO_PUBLIC_HOST=https://doco.example.com on the dev server"
    - "POST /onboarding/create/agent with form fields"
    - "Response page contains doco_url=https://doco.example.com/host-bootstrap/<slug>"
    - "Response page contains claim_url=https://doco.example.com/claim/<token>"
    - "All references to host in shareable artifacts use the override; redirects (e.g. /sign-in?next=…) keep relative paths"

started_at: 2026-05-09T15:20:00Z
ended_at: 2026-05-09T15:25:00Z

created_at: 2026-05-09T15:25:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 10.1 — DOCO_PUBLIC_HOST override

## What ships

A single helper `getPublicBaseUrl(request)`. Reads `DOCO_PUBLIC_HOST`
env var first; falls back to the incoming request's host. Replaces six
inline `${url.protocol}//${url.host}` constructions across the wizard
and invitation routes.

## How to use

For local dev with off-machine agents:

```
ngrok http 5173                     # in one terminal
DOCO_PUBLIC_HOST=https://abcd.ngrok.io \
  DOCO_ROOT=/tmp/your-host \
  pnpm --filter @doco/web dev      # in another
```

Now any URL the wizard hands to a human (invitation URL, claim URL,
agent-bootstrap URL, copyable "tell your agent" message) points at the
ngrok tunnel. Agents in other contexts can fetch it.

## What's still localhost

Internal redirects (`/sign-in?next=…`, `/onboarding/create`, etc.) stay
relative — they only matter inside the same browser session and don't
need the public host. The override is strictly for outbound URLs that
get pasted to other contexts.

## Phase 6 supersedes this

When the hosted deployment lands (per PLANNING.md / ADR-053), the env
var becomes redundant — the deployed instance has its own canonical
host name. The helper continues to work there: `DOCO_PUBLIC_HOST`
either matches the canonical host (no-op) or is unset (the request's
host *is* the canonical host).

The env var is documented as a v0 escape hatch in this Action.
Production hosts shouldn't need it.
