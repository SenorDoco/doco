---
id: action_01KR6HJAC1CX6X0GZR0WCSV5Y0
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 9 — role-based agent provisioning. /agents/new creates Principal{type:agent} + DOCO_TOKEN in one click; /agents lists owned agents. Replaces invitation ceremony for self-service enrollment."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: implement_role_based_provisioning
target: doco_01KR441EA0ZDMF0N5DY38GSVS3

intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6HJABS6GYHR9DXP4DZVRHR   # ADR-071 — Role + session split
  - decision_01KR441EADRWT85TW0SRR3NNX3   # ADR-068 — invitation flow (now superseded for primary path)

inputs:
  agent_observation: |
    A receiving Claude Code session in another project refused to redeem
    the invitation URL with three correct objections: (1) no persistent
    identity to bind to, (2) one-click invite links are phishing-shaped,
    (3) localhost from another CLI session is unreachable. The fix had
    to be on the sending side, with the *human* creating the credential.
  founder_choice: |
    From the brainstorm options, the founder picked E: Role + session
    split. Durable agent identity = Principal{type:agent} the human
    creates. Sessions are an audit-only label the agent emits.

outputs:
  source_files_changed:
    - packages/web/app/routes/agents._index.tsx          # NEW — list signed-in human's owned agent Principals
    - packages/web/app/routes/agents.new.tsx             # NEW — form to create Principal{type:agent} + show DOCO_TOKEN once
    - packages/web/app/routes.ts                         # registered /agents and /agents/new
    - packages/web/app/components/site-header.tsx        # added "Agents" tab in host-mode nav
    - packages/web/app/lib/redeem.server.ts              # re-exported addAgentPrincipal for web's server-only use
    - decisions/decision_01KR6HJABS6GYHR9DXP4DZVRHR.md   # ADR-071
    - packages/index/src/__tests__/build.test.ts         # decision/action counts bumped
    - packages/core/src/__tests__/loader.test.ts         # decision lower-bound bumped
  ui_flow:
    - "Sign in as alice → 'Agents' nav tab → list view with table of owned agents + '+ New agent' CTA"
    - "Click '+ New agent' → form with display_name, model, provider, capabilities"
    - "Submit → host creates Principal{type:agent, owner_id:alice} + issues session token; UI shows the DOCO_TOKEN once with copy button + quick-start curl"
    - "Quick-start shows: export DOCO_TOKEN=...; curl /api/v1/health; spawn sub-tool curl"
  e2e_browser_verified:
    - "Created my-coding-claude via the form"
    - "Token authenticated against /api/v1/health"
    - "Spawned a sub-tool child whose owner_id chain is sub-tool → my-coding-claude → alice — human-ancestry rule preserved"
  tests:
    full_workspace: "all 10 packages green via `pnpm -r test`"
    typecheck: "all 10 packages clean"
    lints: "4/4 clean (orphan-reasoning, agent-ancestry, bugfix-guard, pii-display-name)"

started_at: 2026-05-09T14:05:00Z
ended_at: 2026-05-09T14:25:00Z

created_at: 2026-05-09T14:25:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 9 — Role-based agent provisioning

The "agent visits a URL to redeem an invitation" ceremony was the wrong
shape. ADR-071 captures why. This Action ships the alternative: the
human creates the agent's durable identity directly via the web UI,
gets a token, and provisions it to their tooling — exactly like every
other system that works (PATs, API keys, etc.).

## What ships

### `/agents` — list

A signed-in human's home for their non-human Principals. Shows
display_name, model, provider, created_at, principal id. "+ New agent"
CTA top-right. Replaces the role of `/invite` for the human-side
discoverability of agent management.

### `/agents/new` — create

Single form: display_name (required), model, provider, capabilities
(comma-separated, optional). Submit → server-side:

1. Generate username per ADR-036 (`{owner_username}/{ISO}`).
2. Call `addAgentPrincipal` (extracted from `@doco/api` in Phase 8.1)
   to write `principals/principal_<ulid>.yaml` with `type: agent`,
   `owner_id: <signed-in human>`, and the agent_metadata block.
3. Issue a long-lived session token via TokenStore.
4. Render a one-time success page with the token + quick-start.

The success page shows DOCO_TOKEN once with a copy button and a
quick-start code block (env var export, health check curl, spawn
sub-tool curl). The page emphasizes: "Copy now — we won't show it
again."

### Site nav

Added an "Agents" tab in host-mode site nav. Goes next to "Docos".

## Why this works where the invitation flow didn't

| Receiving agent's objection | How E resolves it |
|---|---|
| "I'm a CLI session, no persistent identity to bind to" | The token *is* the durable identity. The human owns the token; agents read it from env. Sessions are ephemeral and self-declared (label, not auth). |
| "One-click invite links look like phishing" | No URL is shared with the agent. The human creates the credential while signed in to their own host account. Matches PAT pattern. |
| "Localhost from another CLI session is unreachable" | Agents only need to reach the API (`/api/v1/...`), which is just an HTTP endpoint. The web's `/agents/new` page is the human's tool, not the agent's. |

## What doesn't change

- **Human-ancestry rule** (`rule_agent_ancestry_terminates_at_human`)
  is preserved. Every Principal{type:agent} has `owner_id` →
  Principal{type:human}. Verified end-to-end: spawned a sub-tool whose
  chain is `sub-tool → my-coding-claude → alice`.
- **Strict-cascade revocation** (ADR-038) still applies — revoking an
  agent's token cascades to its spawned children.
- **`POST /api/v1/agents/spawn`** still works for the parent-agent →
  child-agent delegation case. Agents that genuinely need to spawn
  sub-agents still can; humans don't have to be in the loop for every
  delegation.

## What's deferred

- **`/agents/:id/revoke`** — the list page doesn't yet have a revoke
  button. The API endpoint exists; wiring up a same-origin web button
  is mechanical, follow-up.
- **`session_id` field on Action / Reasoning** — additive schema
  change in ADR-071. Implement when the audit UI starts grouping by
  session.
- **Deprecating `/invite`** — kept working for backward compat. Remove
  once usage logs show no clients hitting it.
- **CLI `doco agent register` reframing** — its docs should change
  from "agent redeems invitation" to "human authenticates and creates
  credential headlessly". Unchanged code-wise; documentation update.
