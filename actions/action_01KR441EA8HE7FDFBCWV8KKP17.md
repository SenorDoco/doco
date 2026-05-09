---
id: action_01KR441EA8HE7FDFBCWV8KKP17
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Added cookie-based sign-in to web in host mode: anonymous users see a logo-centered landing; signed-in users see the dashboard. Production swaps to GitHub OAuth (ADR-034)."

actor_id: principal_01KR441EA259F7EE420Z4VWFPJ
verb: add_web_signin

intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
  - intent_01KR441EACJYB895DWKG7Z25SF

decision_ids:
  - decision_01KR441EA73AHJ5C8JYA3YQE3R   # ADR-066 web sign-in (cookie now, OAuth later)
  - decision_01KR441EBNZJTAW29W7YM38K30   # ADR-034 GitHub OAuth (production target)
  - decision_01KR441EABVKC40TW04ZF11T9E   # ADR-057 GitHub OAuth deferred to phase 6

inputs:
  trigger: "Founder: 'Logo should be on home page of not signed in users'"

outputs:
  files_added:
    - packages/web/app/lib/session.ts                # cookie + Principal resolver
    - packages/web/app/routes/sign-in.tsx            # User picker + POST handler
    - packages/web/app/routes/sign-out.tsx           # clear-cookie action
  files_changed:
    - packages/web/app/routes/_index.tsx             # branches host-anonymous landing vs host dashboard
    - packages/web/app/components/site-header.tsx    # user pill or "Sign in" CTA in header
    - packages/web/app/routes.ts                     # registers /sign-in + /sign-out
  cookie:
    name: evalo_session
    value: "principal_<ulid>"
    flags: "HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000"
    signed: false   # local-dev only; production replaces sign-in with GitHub OAuth
  e2e_chrome:
    - "anonymous /          → landing, logo 112px, two Sign-in CTAs"
    - "/sign-in             → User picker (3 users + emails)"
    - "POST /sign-in         → 302 redirect with Set-Cookie"
    - "signed-in /          → dashboard with 'torrenegra' pill + Sign-out + Evalos table"
    - "POST /sign-out        → 302 + cookie cleared; / shows landing again"

started_at: 2026-05-09T00:00:00Z
ended_at: 2026-05-09T00:30:00Z

created_at: 2026-05-09T00:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: succeeded
status: completed
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# Web sign-in (host mode): anonymous landing + signed-in dashboard

Anonymous home in host mode now centers the wordmark (h-32, ~112 px) above
"Alignment framework + runtime checking" with a primary "Sign in" CTA and a
secondary "Learn more" link. Signed-in home is the existing dashboard
(Evalos table, Users, Orgs) plus a username pill in the header with a
"Sign out" form-post.

The single-Evalo home (the framework's meta-Evalo at /Users/torrenegra/Evalo)
is unchanged — it's not a multi-tenant context, so sign-in there is moot.

Production deploy (Phase 6 / `evalo.to`) swaps `/sign-in` for the GitHub
OAuth callback handler — same cookie shape, no other changes.
