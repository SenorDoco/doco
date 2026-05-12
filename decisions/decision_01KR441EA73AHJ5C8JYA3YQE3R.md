---
id: decision_01KR441EA73AHJ5C8JYA3YQE3R
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Web has a sign-in concept in host mode: not-signed-in users see a logo-centered landing; signed-in users see the dashboard. Local-dev uses a Principal-picker + cookie session; production swaps to GitHub OAuth (ADR-034)."

slug: web-sign-in-cookie-local-then-github-oauth
number: "ADR-066"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "How does the web distinguish 'logged in' from 'logged out' so the home page can show a marketing/landing view to anonymous visitors and a dashboard to signed-in users — without requiring real auth in local-dev?"
chosen: |
  Two-stage sign-in:

  - **Local-dev (Phase 7+):** `/sign-in` lists the host's registered Users
    (humans only) and lets the visitor pick one. Picking sets an HttpOnly
    `doco_session` cookie carrying the principal_id; the dashboard reads it
    via `getCurrentPrincipal(request)`. Sign-out clears the cookie. No
    password / OAuth — purely a "switch identity" affordance for the local
    multi-tenant model.
  - **Public deploy (Phase 6 / SaaS):** Same cookie shape, but populated by
    GitHub OAuth callback (ADR-034 / ADR-057). The web's session module
    stays unchanged; only the sign-in route changes.

  Home page branches:
  - Not signed in → centered hero with the wordmark, brief tagline, and a
    "Sign in" CTA. Logo is the dominant element.
  - Signed in → existing host dashboard (Docos / Users / Orgs).

  Header always shows either a "Sign in" link or the current user's pill
  with a "Sign out" form-post.
alternatives:
  - name: Skip web auth in local-dev (anyone sees everything)
    rejected_because: "Founder explicitly asked for the logo to show on the home page of not-signed-in users — that requires a sign-in concept. Also positions the codebase for the public deployment without rework."
  - name: Implement GitHub OAuth even for localhost
    rejected_because: "Requires app registration + a public callback URL — incompatible with the local-first scope per ADR-053. Defer until Phase 6."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-09T00:00:00Z
superseded_by: decision_01KREMDWG6SWKFHR5P1RDB64NC

created_at: 2026-05-09T00:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: superseded
status: superseded
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-066 — Web sign-in (cookie locally; GitHub OAuth in prod)

Implementation:
- `app/lib/session.ts` — `getSessionPrincipalId(request)`, `setSessionCookie(id)`,
  `clearSessionCookie()`, `findPrincipalById(id)` helper.
- `app/routes/sign-in.tsx` — GET shows User picker; POST writes cookie.
- `app/routes/sign-out.tsx` — POST clears cookie + redirects.
- `app/routes/_index.tsx` — branches on `getCurrentPrincipal()`:
  signed-in → dashboard, anonymous → wordmark landing.
- `app/components/site-header.tsx` — user pill or "Sign in" link.

The cookie carries a bare principal_id; no signing/encryption locally
(low-trust environment by definition). Production replaces the picker with
the OAuth callback handler — same cookie shape, same downstream code.
