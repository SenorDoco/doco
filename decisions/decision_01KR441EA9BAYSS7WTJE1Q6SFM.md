---
id: decision_01KR441EA9BAYSS7WTJE1Q6SFM
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Web self-service: anyone can sign up, create Docos, and create Organizations from the browser. A reserved-slug list prevents owner names from colliding with Doco's own URL routes."

slug: web-self-service-and-reserved-slugs
number: "ADR-067"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "What does an end user need from the web to use Doco without dropping to the CLI, and how do we keep owner namespaces from colliding with Doco's URL routes?"
chosen: |
  Five web flows close the end-user gap:

  1. **`/sign-up`** — register a new User Principal. Username + optional email;
     immediately sets a session cookie.
  2. **`/new-doco`** — create a new Doco. Owner picker (current user + orgs
     they own/admin); slug, description, visibility.
  3. **`/new-org`** — create a new Organization. Slug, display name,
     description, visibility. Current user becomes the org's owner.
  4. **`/:slug`** — owner profile. Resolves to a User or Organization; shows
     their Docos and basic metadata.
  5. **`/:owner/:doco/e/:type`, `/:owner/:doco/search`, `/:owner/:doco/lint`** —
     per-Doco parity with single-Doco mode (list views, FTS+find-rules,
     system lints).

  **Reserved slugs** (rejected by `addPrincipal`, `addOrganization`,
  `createDocoInHost`):
  ```
  e, host, api,
  search, lint, find-rules,
  sign-in, sign-out, sign-up,
  new-doco, new-org, new,
  admin, settings, profile, help, about
  ```
  Anything that names a top-level route in `@doco/web` is reserved so
  `/:slug` and `/:owner/:doco/...` route to the right place. Slug pattern
  is also enforced as `^[a-z0-9_-]+$`.
alternatives:
  - name: Allow any slug; disambiguate at routing time
    rejected_because: "Routing precedence is fragile across React Router versions; an explicit reserved list is unambiguous and enforced at write time (a User named 'sign-in' never gets created)."
  - name: Defer self-service to Phase 6 (deploy)
    rejected_because: "Founder asked to build it now: end-user navigation requires creation flows. Local-first multi-tenant without web creation forces the CLI on every user — defeats the host's purpose."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-09T01:00:00Z
superseded_by: decision_01KREMDWG6SWKFHR5P1RDB64NC

created_at: 2026-05-09T01:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: superseded
status: superseded
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-067 — Web self-service + reserved-slug list

Production deploy keeps the same web flows; sign-up specifically swaps to
the GitHub OAuth callback (creating a Principal mirroring the GitHub user)
per ADR-034. Local-dev sign-up has no password — picking a username is
sufficient because the host is on the user's own machine.
