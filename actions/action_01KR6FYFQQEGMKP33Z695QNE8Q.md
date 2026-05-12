---
id: action_01KR6FYFQQEGMKP33Z695QNE8Q
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Agent-side /invite/:token page: self-describing HTML + embedded JSON-LD; .json resource route for headless agents. Closes the 'pasted URL alone confuses an agent' gap."

actor_id: claude-opus-4-7   # claude-opus-4-7 (agent)
verb: implement_agent_side_invitation_page
target: doco_01KR441EA0ZDMF0N5DY38GSVS3

intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0

decision_ids:
  - decision_01KR6FYFQNZRCV7KQSKEVGV9PK   # ADR-069 — this Action operationalizes it
  - decision_01KR441EADRWT85TW0SRR3NNX3   # ADR-068 — invitation-flow implementation (predecessor)

inputs:
  founder_observation: |
    "Notice how just sharing what you wrote confuses the agent."
    The user pasted the invitation URL I had given them into a different
    Claude Code session in another repo. That agent, with no context,
    correctly refused to act on the URL and flagged it as out-of-place.
    The URL alone communicated nothing about what it was — that's the
    gap this Action fills.
  prior_design:
    - decisions/ADR-068 (invitation-flow implementation; left GET unspecified)

outputs:
  source_files_changed:
    - packages/api/src/agents.ts                            # NEW — extracted shared invitation-redemption + agent-creation logic (findPrincipalById, addAgentPrincipal, redeemInvitation) so both API server and web route use the same primitives
    - packages/api/src/server.ts                            # refactored to use ./agents helpers; removed inline hostAddPrincipalAsAgent + findPrincipalById
    - packages/api/src/index.ts                             # auto via re-export of ./server.js
    - packages/web/app/lib/redeem.server.ts                 # NEW — server-only re-export of @doco/api's redemption helpers
    - packages/web/app/routes/invite.$token.tsx             # NEW — UI route. Self-describing HTML page (4 prose sections + form + curl) + JSON-LD <script type="application/ld+json"> embedded in every render
    - packages/web/app/routes/invite.$token[.]json.tsx      # NEW — resource route (no default export). GET returns JSON manifest; POST accepts redemption body and returns JSON { session_token, principal }
    - packages/web/app/routes.ts                            # registered both routes
    - packages/index/src/__tests__/build.test.ts            # action count 14 → 15
  decisions_captured:
    - decisions/decision_01KR6FYFQNZRCV7KQSKEVGV9PK.md       # ADR-069
  tests:
    api: "12 passing — refactor preserves behavior"
    full_workspace: "all 10 packages green via `pnpm -r test`"
  e2e_curl_verified:
    - "GET /invite/<token>.json — manifest with kind, host, inviter, expires_at, redeem.url, redeem.body_schema, redeem.example_body, notes"
    - "GET /invite/<token> — HTML page contains <script type='application/ld+json'> with the same manifest"
    - "POST /invite/<token>.json + JSON body — returns 201 with { session_token, principal: { id, username, display_name, type:agent, owner_id } }"
    - "POST /invite/<token> + form body — renders HTML success page with the session token"
    - "Browser walkthrough verified in Chrome: page renders, all sections legible, form submits, success page shows the session token + spawn-curl recipe"

started_at: 2026-05-09T13:30:00Z
ended_at: 2026-05-09T13:50:00Z

created_at: 2026-05-09T13:50:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA7ABSBBYM1JX3A8429   # tag_userflow
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Phase 8.1 — Agent-side invitation page

The user observed mid-session that pasting the invitation URL to an
agent in another project produced refusal: the agent had no context
for what the URL was, and correctly flagged it. That's a real flaw in
the v0 design — the URL was supposed to be self-describing per the
original requirements ("share a URL, agent self-registers"). Until this
Action, GET on the URL produced nothing useful. The agent had to be
told, out-of-band, what to do.

## What this Action ships

### Self-describing HTML page

`GET /invite/:token` now returns a page with four prose sections:

1. **What this is** — type, expiry, scope, references to ADRs.
2. **What happens when you redeem** — Principal creation, ownership
   binding, single-use semantics, session-token issuance, the
   only-humans-delete-Docos rule.
3. **Don't recognize this URL?** — explicit graceful exit ("simply
   ignore it; it expires in 5 minutes").
4. **Redeem** — a clickable browser form (humans), a curl example
   (headless agents), and a pointer to the JSON manifest URL.

### JSON-LD embedded in HTML

Every render of the HTML page includes a `<script
type="application/ld+json">` block carrying the manifest. An agent
fetching the URL with any Accept header gets HTML they can grep for
this block to extract structured data. No prior context required.

### `.json` resource route

`/invite/:token.json` is a parallel resource route (loader + action,
no default export):

- `GET` → manifest JSON with `kind`, `host`, `inviter`, `expires_at`,
  `redeem.{url,method,headers,body_schema,example_body}`, `notes[]`.
- `POST` → redeems the invitation; returns `{ session_token, principal }`
  with `201 Created`.

The HTML page's `redeem.url` points at this `.json` URL so any agent
following the manifest's instructions ends up at a JSON-clean endpoint.

### Why a separate resource route

In React Router v7, throwing or returning a `Response` from a UI route
keeps the status code but the body gets re-rendered as the route's
HTML — observed by setting `status: 418` in a `throw new Response()`
and watching the response come back as HTTP 418 with `content-type:
text/html`. Only routes with no default export (resource routes) serve
raw `Response` bodies. Hence the parallel `.json` file.

### Refactor: shared redemption logic

The redemption + agent-Principal-creation logic was inline in
`packages/api/src/server.ts`. Extracted into `packages/api/src/agents.ts`
as three exported functions:

- `findPrincipalById(root, id)` — look up a Principal in the host tree.
- `addAgentPrincipal(root, opts)` — write a `principal_<ulid>.yaml`
  with `type: agent`, `owner_id`, and `agent_metadata`.
- `redeemInvitation(root, token, body)` — full single-use redemption:
  resolve invitation → find inviter → create agent Principal →
  mark invitation used → issue session token. Returns
  `{ session_token, principal } | { error: ... }`.

`server.ts`'s redeem endpoint now wraps `redeemInvitation`, and the
new web routes use it via `~/lib/redeem.server.ts` (a server-only
re-export, mirroring `tokens.server.ts`).

## Verification

| Surface | Result |
|---|---|
| `pnpm -r test` | 10/10 packages green |
| `pnpm --filter @doco/web typecheck` | clean |
| `curl /invite/<token>.json` | full manifest |
| `curl -X POST /invite/<token>.json` (JSON body) | 201, session_token |
| `curl /invite/<token>` | HTML with embedded JSON-LD |
| Browser walkthrough at /invite/<token> | renders fully |

## What's still deferred

- **JSON-LD vocabulary registration** — `kind: "doco_invitation"` is
  bespoke today. Future ADR can register a canonical context URL.
- **Signed manifests** — agents currently trust the manifest because they
  trust the URL source. Future hardening could sign the JSON-LD with
  the host's key.
- **Fragment-based URLs** — ADR-068 deferred `…/invite/<slug>#token=…`
  for log hygiene. When that lands, the GET endpoint moves to a stub
  page that reads the fragment client-side.
- **API server's redeem endpoint** — kept for backward compatibility.
  Agents can still POST to `/api/v1/invitations/redeem` if the API
  server is running on its own port; the web's `.json` route is the
  preferred path for v0 since both surfaces can run from the same
  origin.
