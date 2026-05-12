---
id: action_01KRERQZBFTTCM53A1A4N70MYD
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Phase 25 — GitHub OAuth is the only path to create a human account. Built /auth/github + /auth/github/callback, replaced /sign-up form with a GitHub button, added oauth.server.ts helper, extended addPrincipal with GitHub identity."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: ship_github_oauth_only_signup

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decisions_consulted:
  - decision_01KRERQZBDDF6B0CVRMN3CGPVE   # ADR-095 (this Phase's source decision)
  - decision_01KREQ7P29ZHQV4G663TX89BKG   # ADR-094 (public deploy plan that this refines)
  - decision_01KR441EBNZJTAW29W7YM38K30   # ADR-034 (GitHub-only humans — the policy this enforces)

inputs:
  founder_direction: |
    "Keep in mind that only humans should be able to create accounts, and for
    now the only way to create an account is by connecting with Github."

outputs:
  shipped:
    web:
      - packages/web/app/lib/oauth.server.ts (NEW — HMAC-signed state cookie, code exchange, GitHub user + email fetch)
      - packages/web/app/routes/auth.github.tsx (NEW — kicks off OAuth; falls back to a setup page when env vars are missing)
      - packages/web/app/routes/auth.github.callback.tsx (NEW — state verify, code-for-token, profile fetch, create-or-find Principal, session cookie, redirect to /)
      - packages/web/app/routes.ts (registered /auth/github + /auth/github/callback)
      - packages/web/app/routes/sign-up.tsx (replaced manual username/email form with "Continue with GitHub")
      - packages/web/app/routes/sign-in.tsx (GitHub-first; the local-dev username picker is now gated by DOCO_LOCALHOST_PICKER=1 and off by default)
    host:
      - packages/host/src/host.ts — addPrincipal accepts optional github_identity (github_id, github_login, email); findPrincipalByGitHubLogin exported
    docs:
      - .env.example (NEW — documents DOCO_GITHUB_CLIENT_ID, DOCO_GITHUB_CLIENT_SECRET, DOCO_GITHUB_REDIRECT_URI, DOCO_GITHUB_STATE_KEY, DOCO_LOCALHOST_PICKER, DOCO_ROOT, OPENAI_API_KEY)
  invariants_enforced:
    - "addPrincipal always sets type: \"human\" — no code path can create a Principal with type: agent via OAuth"
    - "Agent Principals come only through the invitation flow (/agents/new, addAgentPrincipal); separate from /auth/github"
    - "CSRF: signed state cookie (HMAC-SHA-256) with 10-minute TTL; callback rejects on missing cookie, mismatch, bad signature, or expired"
  verification:
    - "pnpm -r build: 10 packages compile clean"
    - "pnpm -r test: 100 tests pass"
    - "doco validate: 176 entities valid"
    - "/sign-up HTTP 200; contains 'Continue with GitHub' button (no manual form)"
    - "/sign-in HTTP 200; picker hidden (DOCO_LOCALHOST_PICKER unset)"
    - "/auth/github without env vars: HTTP 200 setup page with GitHub OAuth registration steps"
    - "/auth/github with mock env vars: HTTP 302 to https://github.com/login/oauth/authorize?... with signed state cookie set"
    - "/auth/github/callback with mismatched state: HTTP 400 (CSRF protection works)"
  not_yet_shipped:
    - "Real GitHub OAuth round-trip — requires the founder to register a GitHub OAuth App and set DOCO_GITHUB_CLIENT_ID + DOCO_GITHUB_CLIENT_SECRET in .env. Then a real /auth/github click creates a Principal with the GitHub identity attached."
    - "Production GitHub OAuth app for doco.dev — same flow, separate app + credentials; per ADR-094"
    - "Postgres-backed Principal store — current code reads/writes principals/ on disk; production wants a real DB"
    - "Per-Doco API endpoints at /api/v1/<owner>/<doco>/... — still pending from Phase 24"

created_at: 2026-05-12T14:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
started_at: 2026-05-12T13:30:00Z
ended_at: 2026-05-12T14:00:00Z
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Phase 25 — GitHub OAuth is the only sign-up path

## End-to-end test (with mock credentials)

```
$ DOCO_GITHUB_CLIENT_ID=test DOCO_GITHUB_CLIENT_SECRET=test pnpm --filter @doco/web dev

$ curl -i http://127.0.0.1:5173/auth/github
HTTP/1.1 302
location: https://github.com/login/oauth/authorize?client_id=test&scope=read%3Auser+user%3Aemail&redirect_uri=…&state=<nonce>.<ts>.<hmac>&allow_signup=true
set-cookie: doco_oauth_state=…; HttpOnly; SameSite=Lax; Max-Age=600

$ curl -i 'http://127.0.0.1:5173/auth/github/callback?code=abc&state=xyz'
HTTP/1.1 400  (missing/mismatched state cookie — CSRF protection)
```

The full round-trip needs a real GitHub OAuth app:

1. https://github.com/settings/developers → New OAuth App
2. Authorization callback URL: `http://127.0.0.1:5173/auth/github/callback`
3. Copy `Client ID` + generate a `Client Secret` → paste into `.env`:
   ```
   DOCO_GITHUB_CLIENT_ID=…
   DOCO_GITHUB_CLIENT_SECRET=…
   ```
4. Restart `pnpm --filter @doco/web dev`
5. Visit http://127.0.0.1:5173/sign-up → click "Continue with GitHub"
6. After GitHub auth, returns to http://127.0.0.1:5173/ signed in as your GitHub identity.

## Why no localhost mock

We could ship a `DOCO_GITHUB_MOCK=1` flag that bypasses GitHub and creates a
test Principal directly. We don't — ADR-095 rejected the mock because it
would let agents/bots bypass identity verification. The two-minute OAuth-app
setup keeps localhost identical to production, which keeps the security
property honest.
