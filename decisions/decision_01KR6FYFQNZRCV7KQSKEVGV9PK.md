---
id: decision_01KR6FYFQNZRCV7KQSKEVGV9PK
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Agent-side invitation page: GET /invite/:token returns a self-describing HTML page with embedded JSON-LD; /invite/:token.json is a JSON resource route. Solves the 'pasted URL confuses an out-of-context agent' problem."

slug: agent-side-invitation-page
number: "ADR-069"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "ADR-068 specified the issuer side and the redeem POST endpoint, but said nothing about what an agent sees when it visits the invitation URL itself. The user reported: when the URL alone is pasted to an agent in another context, the agent has no way to know what it is. What should GET /invite/:token return?"
chosen: |
  - **HTML page is self-describing.** GET /invite/:token returns a page that
    answers, in plain prose, the four questions an out-of-context agent (or
    human) needs answered:

    1. *what* this URL is — "5-minute, single-use Doco invitation token"
    2. *who* invited them — inviter username + principal id surfaced
    3. *how* to redeem — concrete curl example + a clickable browser form
    4. *why* they might decline — explicit graceful-exit paragraph

    The page is the documentation. No prior context is required.

  - **JSON-LD `<script type="application/ld+json">` is embedded in the page.**
    An agent that fetches the URL via curl gets HTML; it can extract the
    JSON-LD block to learn structured data (kind, host, inviter, expires_at,
    redeem.url, redeem.body_schema, redeem.example_body, notes).

  - **/invite/:token.json is a parallel resource route.** GET returns the
    same manifest as pure JSON; POST accepts a redemption body and returns
    JSON. The HTML manifest's `redeem.url` points to this `.json` URL so
    agents are directed to a JSON-clean endpoint.

  - **Resource route (no default export) is required for true JSON.** In
    React Router v7, throwing or returning a `Response` from a UI route's
    loader/action gets the status preserved but the body re-rendered as the
    route's HTML. Only resource routes (loader/action only, no default
    export) serve raw Responses.

  - **The HTML route's POST also redeems** for browser-form submissions, but
    renders the success/error UI as HTML. Agents that want JSON should POST
    to the `.json` route instead.
alternatives:
  - name: Content negotiation on a single URL via Accept header
    rejected_because: "Tried first. React Router v7 UI routes can't return raw Responses for 2xx status — the framework re-renders the route's HTML. Would need a thrown Response which works but only for non-2xx paths."
  - name: Single URL with ?format=json query param
    rejected_because: "Loses self-description: an agent given the bare URL still gets HTML. The .json suffix is part of the URL's identity, so a fresh agent visiting either URL sees the right thing without prior knowledge."
  - name: Just rely on the JSON-LD in HTML; no .json resource route
    rejected_because: "Forces all agents to parse HTML to extract the manifest. Acceptable but discriminates against simple curl-based clients. The .json route adds 60 LOC and removes the need to parse."
  - name: Tell agents to use /api/v1/invitations/redeem on the API server
    rejected_because: "Couples the web's invitation URL to a separately-running API server. The web has TokenStore access already; making the redeem path live on the same origin as the manifest URL keeps everything self-contained per the v0 spec."
rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0   # agent-ancestry-terminates-at-human
decided_by: torrenegra
decided_at: 2026-05-09T13:50:00Z
superseded_by: decision_01KREMDWG6SWKFHR5P1RDB64NC

created_at: 2026-05-09T13:50:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: superseded
status: superseded
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-069 — Agent-side invitation page

ADR-068 implemented invitation issuance, redemption, and revocation, but
the GET side of `/invite/:token` was left open. In practice, the user
discovered the gap immediately: pasting an invitation URL to an agent in
a different repo's Claude session, the receiving agent had no way to
know what the URL was for, refused to act on it, and (correctly) flagged
it as suspicious.

This Decision fills in the GET endpoint so the URL alone — without any
accompanying instructions — is enough for an agent to:

1. Identify it as an Doco invitation.
2. See who invited them, on which host, with which expiry.
3. Find the exact redeem endpoint, method, headers, body schema, and an
   example body.
4. Decide whether to redeem or decline.

## Endpoint summary (delta over ADR-068)

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/invite/:token` | none | HTML page + embedded JSON-LD |
| `POST` | `/invite/:token` | none (the token is the auth) | HTML success/error |
| `GET` | `/invite/:token.json` | none | JSON manifest |
| `POST` | `/invite/:token.json` | none | JSON `{ session_token, principal }` |

Both POSTs do the same redemption (single-use, marks invite used,
creates Principal{type:agent}, issues session token). They differ only in
response format.

## What the page tells you

The HTML page has four sections (each backed by a paragraph in the
JSON-LD `notes[]` array):

- **What this is** — type, expiry, scope, ADRs.
- **What happens when you redeem** — Principal creation, ownership,
  single-use semantics, session token, the only-humans-delete-Docos
  rule.
- **Don't recognize this URL?** — explicit graceful exit. "Simply ignore
  it. It expires in 5 minutes and never grants access until redeemed."
- **Redeem (browser / curl)** — clickable form + curl recipe with the
  token already filled in.

## React Router v7 lesson encoded here

In React Router v7, throwing or returning a `Response` from a UI route
preserves the response status but re-renders the route's component as
HTML. Only **resource routes** (a route file with a `loader` and/or
`action` but no default export) serve raw Responses. Hence the
`invite.$token[.]json.tsx` file exists as a parallel resource route.
The `[.]` escape in the filename is React Router's way to put a literal
`.` in the URL path (`/invite/:token.json` not
`/invite/:token/json`).

## Future hardening (deferred)

- **JSON-LD vocabulary registration.** Currently `kind: "doco_invitation"`
  and `schema_version: "0.1"` are bespoke. Long-term, register a context
  (e.g. `https://doco.to/contexts/invitation/v1`) so JSON-LD parsers
  can resolve types canonically. v0 keeps it inline.
- **Signed manifests.** A future ADR can require the JSON-LD block (and
  the `.json` response) to be signed by the host's key, so an agent
  can verify the manifest's authenticity before redeeming. Today,
  trust is implicit (the URL came from a trusted human, who trusts the
  host).
- **Fragment-based URL.** ADR-068 deferred `…/invite/<slug>#token=…` to
  keep the token out of HTTP server logs. ADR-069's GET endpoint would
  shift accordingly: the server returns a stub page that reads the
  fragment client-side and POSTs it.
