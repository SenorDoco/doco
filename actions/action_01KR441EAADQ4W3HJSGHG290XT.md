---
id: action_01KR441EAADQ4W3HJSGHG290XT
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Built end-user web self-service: sign-up, create Doco, create Organization, owner profile pages, per-Doco list/search/lint inside host mode. ADR-067 reserved-slug enforcement applied."

actor_id: claude-opus-4-7
verb: implement_self_service_flows

intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB

decision_ids:
  - decision_01KR441EA9BAYSS7WTJE1Q6SFM   # ADR-067 self-service + reserved slugs
  - decision_01KR441EA73AHJ5C8JYA3YQE3R   # ADR-066 web sign-in / sign-up
  - decision_01KR441EA4W857CKWRRWZNT2NW   # ADR-064 shared owner namespace

inputs:
  trigger: "Founder: 'Build them all' (sign-up + create Doco + create org + profile pages + per-Doco nav inside host)."

outputs:
  host_pkg_changes:
    - "RESERVED_SLUGS set + assertSlugAllowed (ADR-067)"
    - "applied to addPrincipal, addOrganization, createDocoInHost"
    - "2 new tests (10 host tests pass total)"
  web_routes_added:
    - "GET/POST /sign-up        — register a new User and auto sign-in"
    - "GET/POST /new-doco      — create Doco under self or any org I own/admin"
    - "GET/POST /new-org        — create Organization owned by me"
    - "GET /:ownerSlug          — owner profile (User or Organization), shows their Docos + members"
    - "GET /:owner/:doco/e/:type            — list entities of a type within an Doco"
    - "GET /:owner/:doco/search             — FTS5 + find-rules within an Doco"
    - "GET /:owner/:doco/lint               — run lints within an Doco"
  web_lib_added:
    - "listOrgsOwnedOrAdminedBy(principalId) — owners I can create Docos under"
  web_components_changed:
    - "site-header: + Doco / + Org buttons; username pill links to /:slug; per-Doco nav now mirrors single-Doco (Intents/Rules/Decisions/Actions/Search/Lint)"
    - "sign-in: link to /sign-up"
  e2e_curl:
    - "sign-up creates a User, sets cookie, redirects to /"
    - "new-doco creates a per-Doco subtree at docos/<owner>/<slug>/ and reindexes"
    - "new-org creates org owned by current user, redirects to /:slug profile"
    - "/:slug profile renders owner info + Docos + (org) members"

started_at: 2026-05-09T01:30:00Z
ended_at: 2026-05-09T02:30:00Z

created_at: 2026-05-09T02:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: completed
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# End-user self-service web flows

What an end user can now do entirely from the web in host mode:

1. **Sign up** at `/sign-up` — pick a username, optional email, immediately
   signed in.
2. **Create an Doco** at `/new-doco` — pick owner (self or any org I own
   or admin), enter a slug, choose visibility. Lands at `/:owner/:slug`.
3. **Create an Organization** at `/new-org` — slug + display name +
   description. I become the org owner. Lands at `/:slug`.
4. **Browse owner profiles** at `/:slug` — shows Docos and (for orgs)
   members.
5. **Inside an Doco** — recent feed, list-by-type, entity detail with
   edges, search (FTS + find-rules), and lint — all scoped to that Doco.

Reserved slugs (ADR-067) prevent collisions with the URL routing layer:
`e`, `host`, `api`, `search`, `lint`, `find-rules`, `sign-in`, `sign-out`,
`sign-up`, `new-doco`, `new-org`, `new`, `admin`, `settings`, `profile`,
`help`, `about`. Slug pattern `^[a-z0-9_-]+$` is also enforced.

## What's still CLI-only

- Inviting an agent (Phase 4 invitation-token flow has no web UI yet).
- Adding/removing org members.
- Editing entity content from the web (entities are still authored by
  filesystem edits + reindex).
