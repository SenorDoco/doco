---
id: decision_01KREQ7P29ZHQV4G663TX89BKG
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"

slug: public-deploy-plan
number: "ADR-094"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
follows:
  - decision_01KREQ7P27K069RBX42APKTBQX   # ADR-092 (hosted multi-tenant is the only shape)
summary: "Public-deploy plan: doco.dev domain, GitHub OAuth sign-up, Postgres-backed sessions + Principal store, Fly.io + Cloudflare for hosting, Sentry + PostHog for observability. localhost shape unchanged — deploy is same code at different URL."

question: "ADR-092 says Doco will be deployed to a public domain. Today it runs on 127.0.0.1:5173. What does the production deploy look like? Domain, sign-up, sessions, hosting, observability — settle the open questions before the localhost UX gets too far from the deploy UX."

chosen: |
  ### Domain: doco.dev

  - **doco.dev** is the production target. `.dev` is HSTS-preloaded
    (HTTPS only at the browser level), affordable, and audience-aligned
    (the framework's users are developers + AI agents). Mirrors the
    audience-match argument from ADR-089-deprecated/ADR-domain-tld.
  - DNS root → Cloudflare; subdomains:
    - `doco.dev` — the host home, host listing + sign-in
    - `<owner>.doco.dev/<doco-slug>` — *future* per-owner subdomain
      (not v0; just plain `/owner/slug` for now)
    - `api.doco.dev` — REST API (currently same-origin via `/api/v1/`;
      promote to subdomain when traffic warrants)

  ### Sign-up: GitHub OAuth

  - Production sign-up = GitHub OAuth flow (ADR-034 covers the
    direction). Creates a `Principal{type:human}` with the GitHub
    login as `username`.
  - localhost retains the picker (ADR-066) for fast iteration — same
    cookie shape, just a different sign-in route. Production swaps
    `/sign-in` to the OAuth callback; the cookie-reading code stays.
  - Email + password is not on the roadmap. GitHub-only (ADR-034 #1
    open question — confirmed closed in this Decision).

  ### Sessions: Postgres-backed TokenStore

  - localhost TokenStore is in-process (a Map in memory).
  - Production needs persistence across deploys + horizontal scaling.
    Postgres holds: `principals`, `organizations`, `sessions`,
    `invitations`. Same schema shape as today's in-memory store,
    just persisted.
  - Cookie remains a bare principal_id (HttpOnly, Secure, SameSite=Lax).
    Production additionally signs the cookie with an HMAC key from
    the host config; localhost is unsigned (low-trust environment).

  ### Hosting: Fly.io (with a Cloudflare fallback)

  - **Fly.io** for v0 — small servers, regional deploys, simple
    Docker shape. The Hono API + the Remix SSR run in one container.
  - **Postgres on Fly** (or Neon as a Postgres-compatible alternative).
  - **Cloudflare** for DNS, TLS termination, edge caching, DDoS
    shielding.
  - The localhost `host.yaml` shape stays the same — production just
    serves it from `/data/doco-host/` instead of the user's workspace.

  ### Observability

  - **Sentry** for error tracking — both API + Web.
  - **PostHog** for product analytics (page views, sign-ups, Doco
    creation rate).
  - **Health endpoint**: `GET /api/v1/health` (already exists) returns
    `{ ok, service, version }`. Production adds DB connectivity check.
  - Logs ship to Fly's structured-log capture; aggregate with Axiom
    or similar when log volume justifies.

  ### What's deferred to its own sub-Decisions

  - Per-owner subdomain routing (`<owner>.doco.dev`) — needs DNS
    work + cookie scoping; not v0.
  - SOC2 / GDPR / compliance — until there's revenue + customer
    demand for it.
  - Billing / pricing — until v1.
  - Custom domains (a customer wants `docs.company.com` → Doco) — v2.

alternatives:
  - name: Deploy to Vercel
    rejected_because: "Vercel is great for static + serverless. Doco's API is long-running (Hono + better-sqlite3 today; Postgres soon), the Recent feed wants a persistent connection or polling endpoint that survives cold starts, and TokenStore wants in-process state. Fly's stateful container model fits better. Revisit if/when the API becomes stateless."
  - name: Self-host on a Hetzner VPS
    rejected_because: "Cheaper, but ops burden eats the savings. Fly's deploy ergonomics + Postgres add-on + WireGuard private networking + log capture are a force multiplier at v0. Self-host later if costs justify."
  - name: Defer the deploy story until after v1
    rejected_because: "Single-doco-mode removal (ADR-093) breaks localhost in a way that needs the host shape to live on disk anyway. Deploy isn't *imminent*, but architectural decisions (cookie signing, DB shape, OAuth) can't wait — they shape the localhost code too."

rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-12T13:00:00Z

created_at: 2026-05-12T13:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-094 — Public deploy plan

## Sequencing

The deploy itself doesn't ship in this Decision; it captures the
architectural choices so the localhost code makes the right shape
calls today.

Immediate effect on localhost code:

1. Cookie session module needs an HMAC-signing path (no-op locally
   if no key configured).
2. TokenStore needs a Postgres adapter alongside the in-memory one.
3. `/sign-in` needs to be pluggable: picker route locally, OAuth
   route in production.
4. GitHub OAuth client ID + secret read from env vars (`DOCO_GITHUB_*`).

Each is its own follow-up Action.

## What gets registered with what

| Vendor | Why |
|---|---|
| Cloudflare | DNS + TLS + WAF |
| Fly.io | App container(s) + Postgres add-on |
| Sentry | Errors |
| PostHog | Analytics |
| GitHub OAuth | Sign-up |

All under the founder's account; ownership transfers when the team
adds members.
