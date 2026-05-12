---
id: decision_01KRERQZBDDF6B0CVRMN3CGPVE
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "GitHub OAuth is the only path to create a human account. No manual sign-up form. Account creation requires a verified GitHub identity. localhost + production use the same OAuth flow (different OAuth apps); no localhost shortcut."

slug: github-oauth-is-the-only-signup-path
number: "ADR-095"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
follows:
  - decision_01KREQ7P29ZHQV4G663TX89BKG   # ADR-094 (public deploy plan; named OAuth as the prod sign-up but localhost retained the picker)
  - decision_01KR441EBNZJTAW29W7YM38K30   # ADR-034 (GitHub-only humans)
question: "ADR-094 said localhost retains the username picker for fast iteration; production swaps to GitHub OAuth. The founder corrected: account creation is GitHub OAuth everywhere — there's no localhost shortcut. What's the canonical sign-up path?"
chosen: |
  **GitHub OAuth is the only way to create a Principal.** Both
  localhost and production. No manual form, no localhost bypass.

  ### Sign-up flow

  1. User visits `/sign-up`. The page is a single button: "Continue
     with GitHub."
  2. Click → `/auth/github` — server generates a signed state cookie
     (CSRF), builds the GitHub authorize URL, and HTTP-redirects to
     `https://github.com/login/oauth/authorize?client_id=…&scope=read:user user:email&state=…&redirect_uri=…`.
  3. GitHub authenticates the user and redirects back to
     `/auth/github/callback?code=…&state=…`.
  4. Server validates state matches the cookie, exchanges code for
     an access token at `https://github.com/login/oauth/access_token`,
     fetches the user's profile at `https://api.github.com/user`, and
     fetches verified emails at `https://api.github.com/user/emails`.
  5. If a Principal with the same GitHub login already exists, sign
     in (set cookie). Otherwise create a new Principal —
     `type: "human"`, `username: <github-login>`,
     `github_identity: { github_id, github_login, email }` — and
     sign in.
  6. Redirect to `/`.

  ### Sign-in flow

  Same OAuth roundtrip — clicking "Sign in with GitHub" on `/sign-in`
  routes through `/auth/github` and matches an existing Principal by
  GitHub login. If none exists, the same call-path creates the
  account (sign-up = sign-in's first time).

  **The localhost picker on `/sign-in`** stays as a *switch-identity*
  affordance for fast local iteration — once you've signed in with
  GitHub at least once, you can pick any registered Principal without
  re-authenticating. Production removes the picker (security hole:
  anyone could pick anyone). Controlled by `DOCO_LOCALHOST_PICKER=1`
  env var; defaults off in production.

  ### Type: human invariant

  Every Principal created via OAuth has `type: "human"`. The
  `addPrincipal` helper in `@doco/host` already hardcodes
  `type: "human"`; OAuth feeds it. Agent Principals come in via the
  invitation flow (`/agents/new`) — never via OAuth.

  This keeps the schema-level invariant clean: agents trace back
  through `owner_id` to a human, and the only way to be a human
  is to have passed GitHub OAuth at least once.

  ### Setup (localhost)

  Founder registers a GitHub OAuth App at
  https://github.com/settings/developers with:
  - Application name: "Doco (local dev)"
  - Homepage URL: `http://127.0.0.1:5173`
  - Authorization callback URL: `http://127.0.0.1:5173/auth/github/callback`

  Then writes to `./.env`:
  ```
  DOCO_GITHUB_CLIENT_ID=<from the OAuth app>
  DOCO_GITHUB_CLIENT_SECRET=<from the OAuth app>
  ```

  Without these, `/auth/github` renders a setup page instead of
  redirecting. No mock fallback — that would let agents/bots create
  accounts.

  ### Setup (production)

  Per ADR-094 a separate GitHub OAuth App is registered for
  `doco.dev`. Same env-var shape, different client ID/secret. The
  callback URL is `https://doco.dev/auth/github/callback`.

alternatives:
  - name: Localhost retains manual sign-up form
    rejected_because: "Lets humans (and worse, agents pretending to be humans) bypass GitHub identity verification. The 'verified human' property is the security backbone of Doco's trust chain. A localhost manual form would fail to enforce that property and would diverge from production in a way that hides bugs."
  - name: Localhost has a mock OAuth that auto-creates a test user
    rejected_because: "Same problem — bypasses identity verification. Plus, the small friction of registering a GitHub OAuth App is worth paying: it forces the dev environment to mirror production. ~2 minutes to set up; once."
  - name: Email + password as a second sign-up option
    rejected_because: "Per ADR-034 + the founder's restatement, GitHub-only. Email/password adds a password-reset flow, a user-table schema, deliverability concerns. None of which earn their keep at v0. Reconsider only if adoption signal demands."
  - name: OIDC / SAML for enterprise SSO
    rejected_because: "Out of scope for v0. Hold for v1+ when there's enterprise demand."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-12T14:00:00Z

created_at: 2026-05-12T14:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-095 — GitHub OAuth is the only sign-up path

## Why this is a separate Decision from ADR-094

ADR-094 framed OAuth as "production swap." That's wrong:
GitHub-OAuth-everywhere is the security model, not the deploy
mechanism. The localhost shortcut from ADR-094 (username picker for
sign-*up*) was conceived for iteration speed; it actively undermines
the "every human verified by an external authority" property.

This ADR refines ADR-094 by removing the localhost shortcut for
sign-*up*. Sign-*in* on localhost retains the picker as an
identity-switcher (for accounts already created via OAuth) gated by
`DOCO_LOCALHOST_PICKER=1` (default off in production).

## What changes in code

| # | Change | Where |
|---|---|---|
| 1 | `/auth/github` route — kicks off OAuth | `packages/web/app/routes/auth.github.tsx` |
| 2 | `/auth/github/callback` route — code exchange + Principal create-or-find | `packages/web/app/routes/auth.github.callback.tsx` |
| 3 | OAuth helper (state, code exchange, profile fetch) | `packages/web/app/lib/oauth.server.ts` |
| 4 | `/sign-up` route — replaced with "Continue with GitHub" button | `packages/web/app/routes/sign-up.tsx` |
| 5 | `/sign-in` route — adds "Sign in with GitHub" button; localhost picker stays gated | `packages/web/app/routes/sign-in.tsx` |
| 6 | `addPrincipal` accepts a GitHub identity object | `packages/host/src/host.ts` |

## What stays human-only

`addPrincipal` already hardcodes `type: "human"`. OAuth is the only
caller. Agent Principals continue to come in through
`addAgentPrincipal` (invitation flow, ADR-037 / ADR-068 / ADR-071) —
those are not reachable from `/sign-up` or `/auth/github`.

The human-ancestry invariant (every agent's `owner_id` chain
terminates at a human) holds: humans require GitHub OAuth; agents
require an inviting Principal.
