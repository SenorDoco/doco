---
id: action_01KR6KS73R56FK2GXV9FQMF1ZG
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 10 — onboarding wizard. Home page becomes Join | Create. Each path splits Human | Agent. Agents can self-create unclaimed Docos and work in full; humans claim ownership later via /claim/<token>."

actor_id: claude-opus-4-7
verb: ship_onboarding_wizard

intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6KS73P659EVRVF73EW823F   # ADR-073 — onboarding wizard

inputs:
  user_design: |
    The user described the onboarding flow in detail: home page with two
    options (Join existing / Create new), each leading to a Human-or-Agent
    interstitial, with four leaves. The agent-create path must work in
    full without human auth — "the agent should be able to start working
    on that Doco in full even if the Doco has not been claimed yet."

outputs:
  source_files_changed:
    - decisions/decision_01KR6KS73P659EVRVF73EW823F.md       # ADR-073
    - packages/api/src/auth.ts                              # added ClaimToken type + issueClaimToken/resolveClaim/markClaimUsed
    - packages/web/app/lib/bootstrap.server.ts              # NEW — getOrCreateHostBootstrap (placeholder Principal for unclaimed Docos)
    - packages/web/app/lib/redeem.server.ts                 # added createDocoInHost + reindex re-exports
    - packages/web/app/lib/session.ts                       # filter bootstrap_placeholder out of sign-in candidates
    - packages/web/app/lib/host.ts                          # filter bootstrap_placeholder out of listUsers
    - packages/web/app/routes/_index.tsx                    # signed-out home → wizard with 2 cards + agent helper note
    - packages/web/app/routes/onboarding.join._index.tsx    # NEW — Human/Agent interstitial; shared RoleSplitPage
    - packages/web/app/routes/onboarding.join.human.tsx     # NEW — copyable "tell agent" message + ask-admin path
    - packages/web/app/routes/onboarding.join.agent.tsx     # NEW — instructions: ask admin to invite
    - packages/web/app/routes/onboarding.create._index.tsx  # NEW — same role-split page reused
    - packages/web/app/routes/onboarding.create.human.tsx   # NEW — copyable "tell agent" + manual create
    - packages/web/app/routes/onboarding.create.agent.tsx   # NEW — form, creates Doco+agent+claim_url+token
    - packages/web/app/routes/claim.$token.tsx              # NEW — human visits, signs in, atomically takes ownership; moves Doco dir + rewrites slug
    - packages/web/app/routes.ts                            # registered all new routes
    - packages/index/src/__tests__/build.test.ts            # bumped counts
    - packages/core/src/__tests__/loader.test.ts            # bumped lower-bound
  e2e_browser_verified:
    - "Anonymous home: 2 cards (Join / Create) + 'Are you an AI agent?' helper note"
    - "/onboarding/join → Human/Agent interstitial → leaf renders with copyable message"
    - "/onboarding/create → Human/Agent interstitial → leaf renders"
    - "/onboarding/create/agent: filled form 'fresh-project' → server created host-bootstrap-owned Doco + bootstrap-owned agent Principal + DOCO_TOKEN + claim_url"
    - "/claim/<token>: signed-out → 'Sign in to claim'; signed in as alice → 'Claim ownership' button; click → atomic transfer:"
    - "  - Doco's owner_id flipped from host-bootstrap → alice"
    - "  - Doco's slug rewritten 'host-bootstrap/fresh-project' → 'alice/fresh-project'"
    - "  - Doco directory moved /docos/host-bootstrap/fresh-project → /docos/alice/fresh-project"
    - "  - Agent Principal's owner_id flipped from host-bootstrap → alice (chain: agent → alice (human) ✓)"
    - "  - Claim token marked used"
    - "  - Redirect to /alice/fresh-project lands on the Doco's home"
  tests:
    full_workspace: "all 10 packages green"
    typecheck: "clean"
  follow_ups:
    - action_01KR6KS73SZHYSFP5RQMHRX3PA   # planned — claim flow hardening (single-test, edge cases)

started_at: 2026-05-09T15:00:00Z
ended_at: 2026-05-09T15:15:00Z

created_at: 2026-05-09T15:15:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 10 — Onboarding wizard

## Tree shipped

```
/ (signed-out)
├── Join an existing Doco  → /onboarding/join
└── Create a new Doco      → /onboarding/create
    "Are you an AI agent and don't know the answer? Ask whomever
     prompted you which way to go."

/onboarding/join  → Human | Agent
├── /onboarding/join/human   — copyable "tell your agent" message
│                              OR ask the Doco's admin to invite
└── /onboarding/join/agent   — instructions: ask admin to invite you

/onboarding/create → Human | Agent
├── /onboarding/create/human  — copyable message OR manual creation
└── /onboarding/create/agent  — FORM → creates Doco + agent + token + claim_url

/claim/<token>    → human signs in, takes ownership atomically
```

## Unclaimed-Doco design

Per ADR-073: the placeholder owner is a `Principal{type:human}` with
username `host-bootstrap` and a `bootstrap_placeholder: true` flag.
Lazily created on first agent-create. The human-ancestry rule is
satisfied (host-bootstrap is type:human). The flag keeps it out of
sign-in candidates and user listings.

When the agent creates an Doco through `/onboarding/create/agent`,
five things happen server-side:

1. `getOrCreateHostBootstrap` ensures the placeholder exists.
2. `createDocoInHost` writes the Doco to
   `/docos/host-bootstrap/<slug>/`.
3. `addAgentPrincipal` writes the new agent owned by host-bootstrap.
4. `TokenStore.issueSessionToken` issues the agent's DOCO_TOKEN.
5. `TokenStore.issueClaimToken` issues a 30-day claim_token bound to
   `(doco_id, bootstrap_agent_id)`.

The agent walks away with: a token to use, a URL to give the human,
and a clean slate to write entities into.

## Claim ceremony

`/claim/<token>` resolves the token, requires sign-in, then atomically:

1. Rewrites Doco's `owner_id` and `slug` to point to the claiming
   human.
2. Rewrites the bootstrap-owned agent's `owner_id` to the human.
3. Moves the Doco directory from
   `/docos/host-bootstrap/<slug>/` to `/docos/<human>/<slug>/`.
4. Marks the claim_token used.
5. Redirects to `/<human>/<slug>` — the Doco's new canonical URL.

After the claim, the chain is `agent → human` for real. No trace of
host-bootstrap remains in the live data (the placeholder principal
itself stays as a host-level singleton; new unclaimed Docos reuse it).

## Verification

End-to-end browser test:

1. Signed out, opened `/onboarding/create/agent`, filled `fresh-project`.
2. Server created Doco + agent + token + claim_url. Page rendered the
   token and a copyable claim-message.
3. Signed in as alice.
4. Visited the claim URL, clicked "Claim ownership".
5. Redirected to `/alice/fresh-project`.
6. Verified on disk:
   - `/docos/host-bootstrap/` is empty
   - `/docos/alice/fresh-project/doco.yaml` shows `owner_id: <alice>` and
     `slug: alice/fresh-project`
   - The agent's principal yaml shows `owner_id: <alice>` (was host-bootstrap)

## Implementation notes

- React Router 7's `.server.ts` convention strips the module from the
  client bundle. Constants from `bootstrap.server.ts` cannot be
  referenced in JSX even at the type level — caused the first try to
  blow up with "Server-only module referenced by client". Fix: a
  parallel `const BOOTSTRAP_USERNAME_LABEL` in the route file for JSX
  text; the .server import is now used only by the action.
- ESM imports vs CommonJS — `require("node:fs")` doesn't work in this
  setup. Use top-level ES imports.
- The `unclaimed: true` schema field was *not* added. The check is
  implicit: `Principal.username === "host-bootstrap"` ⇒ unclaimed
  owner. Schema-clean for v0; add a real field when a lint or query
  needs it.

## Backward compat

Per [action_01KR6JTFDRV2GQ20DKRKKWVD93](action_01KR6JTFDRV2GQ20DKRKKWVD93.md)
(no back-compat pre-v1), the wizard's signed-out home page replaces
the old `HostLanding` "Sign in / Learn more" splash. The signed-in
home dashboard is unchanged. Old `/agents/new` and `/invite` flows
still function.
