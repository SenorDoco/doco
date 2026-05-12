---
id: action_01KR6KS73SZHYSFP5RQMHRX3PA
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: harden the onboarding wizard's claim flow. Edge cases: slug collisions on claim, expired/used token UX, race between two parallel claims, sign-up redirect-back, claim from inside an existing Doco."

actor_id: principal_01KR441EA199MZCP7RDMADFZW9
verb: harden_claim_flow

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT

decision_ids:
  - decision_01KR6KS73P659EVRVF73EW823F   # ADR-073

inputs:
  predecessor: action_01KR6KS73R56FK2GXV9FQMF1ZG
  follows_user_design: |
    The onboarding wizard ships a working agent-create + human-claim
    cycle. This Action captures the rough edges to round off when
    someone next touches the flow.

outputs:
  expected:
    edge_cases_to_handle:
      - "Slug collision on claim: if alice already has /alice/fresh-project, the move fails. Today returns a generic error. Better: prompt the human to rename before claiming."
      - "Expired claim token: today returns 'invalid'. Better: distinguish 'expired' from 'unknown' so the human knows to ask the agent for a fresh URL."
      - "Used claim token: same as expired UX-wise. Distinguish so a human who clicks an old link sees 'already claimed by <username>' instead of generic invalid."
      - "Race: two humans clicking the same claim URL. Today first-wins, second-fails opaquely. Acceptable for v0 but worth a clearer message."
      - "Sign-up flow redirect-back: today /claim/<token> redirects to /sign-in?next=... but /sign-up doesn't carry the next param. Wire that through so signing up returns to the claim page."
      - "Claim from inside an Doco: today claim is a top-level URL, decoupled from any Doco viewer. Could be reachable from the unclaimed Doco's own page when a signed-in human visits — 'Claim this Doco' button right there."
    tests_to_add:
      - "vitest test in packages/api: claim token issued, resolved, used. Cascade not applicable for claim tokens (single-shot)."
      - "vitest test simulating the full claim ceremony — create unclaimed Doco, create claim_token, run the rewriter helpers, assert disk state."
      - "playwright/e2e (when web tests get a runner) — full browser walkthrough."
    schema_polish:
      - "Decide whether to add a formal `unclaimed: true` field on Doco and `bootstrap_placeholder: true` on Principal. Today the check is implicit (username == 'host-bootstrap'). Explicit fields make lint logic more obvious."
      - "If the field lands, lints can warn (not error) on long-unclaimed Docos. Helpful for hosts that get noisy with abandoned drafts."

created_at: 2026-05-09T15:15:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: proposed
status: planned
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Backlog — claim flow hardening

The onboarding wizard's claim ceremony works end-to-end for the
happy path. This Action catalogs the edges that aren't smooth.

## Triggers worth fixing

- **Slug collision** — picked up the moment two agents create
  `fresh-project` for the same human.
- **Token state messages** — humans clicking old/used links want to
  know which kind of failure it is.
- **Sign-up loop** — a human with no account clicks the claim URL,
  gets sent to `/sign-in?next=...`, then `Create an account →`,
  signs up, and lands at `/` — the `next` was lost. Round-trip the
  param through sign-up.

## When to pick up

When this surface gets its second user (someone other than the
founder testing). Current state is fine for the dogfooding loop.

## Anti-patterns to avoid

- Don't add a `force: true` flag to overwrite slug collisions.
  Better to refuse and ask.
- Don't build a "claim this for me" UI from inside an unclaimed
  Doco before the basic claim URL flow is rock-solid. One ceremony
  at a time.
