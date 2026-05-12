---
id: action_01KR6JTFDRV2GQ20DKRKKWVD93
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: action
schema_version: "0.1"
summary: "Backlog: until we reach v1.0, no backward-compat code or UX. Sweep and delete superseded paths (today: the /invite flow + invitation tokens) instead of carrying them forward."

actor_id: torrenegra   # torrenegra (human, founder)
verb: enforce_no_backcompat_pre_v1

intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0

decision_ids:
  - decision_01KR6HJABS6GYHR9DXP4DZVRHR   # ADR-071 — supersedes /invite
  - decision_01KR6JHZYRQYJ3NBWV8RG7CRNR   # ADR-072 — superseded the success-page recipe
  - decision_01KR441EA4F19H61WSEDAYAHVH   # ADR-050 — schema versioning policy (the principle this Action operationalizes for code)

inputs:
  founder_direction: |
    "Add to backlog: remove all UX and code for backward compatibility
    until we reach version 1.0. Right now we are in version 0.1."
  scope_principle: |
    Schema-versioning policy (ADR-050) lets us bump the schema major
    version when we make breaking changes. Code-version policy is the
    same: while schema_version stays at 0.x, no code path is owed a
    deprecation window. New supersedes old immediately.

outputs:
  expected:
    sweep_targets:
      web_routes:
        - "packages/web/app/routes/invite.tsx                  # issuer page; superseded by /agents/new"
        - "packages/web/app/routes/invite.$token.tsx           # agent-side redemption HTML"
        - "packages/web/app/routes/invite.$token[.]json.tsx   # JSON resource route"
        - "packages/web/app/routes.ts                          # remove three /invite/* registrations"
      api_endpoints:
        - "packages/api/src/server.ts                          # remove POST /api/v1/invitations + POST /api/v1/invitations/redeem"
        - "packages/api/src/auth.ts                            # remove InvitationToken type, issueInvitationToken, resolveInvitation, markInvitationUsed, listOpenInvitations, kind discriminator (or simplify back to single session-only token type)"
        - "packages/api/src/__tests__/invitation.test.ts       # delete entirely"
      cli_commands:
        - "packages/cli/src/commands/invite.ts                 # delete"
        - "packages/cli/src/commands/agent.ts                  # delete (the redemption-flow CLI; /agents/new web flow replaces it)"
        - "packages/cli/src/index.ts                           # unregister both subcommands"
      web_lib:
        - "packages/web/app/lib/redeem.server.ts               # narrow to addAgentPrincipal-only re-export, drop redeemInvitation/findPrincipalById exports if /invite goes"
      docs:
        - "AGENT.md                                            # remove any /invite mention (none today; verify on cleanup)"
    keep:
      - "Decisions ADR-035..040, ADR-068..070 — historical record. Decisions are append-only; don't rewrite the journey."
      - "TokenStore session-token logic + revocation cascade — still in active use by /agents/new and POST /api/v1/agents/spawn."
    test_count_deltas:
      - "packages/api: 12 → 8 tests (drop 4 invitation tests)"
      - "packages/index/src/__tests__/build.test.ts            # action count up by 1 (this action itself)"
    rule_companion:
      - "Optional: capture as a Rule (`rule_no_backcompat_pre_v1`) so the lint surface enforces 'when the lifecycle of a code path is superseded, delete it next change'. Probably overkill for v0; the principle is best held by humans, not lints."

created_at: 2026-05-09T14:50:00Z
created_by: claude-opus-4-7
revision: 2
lifecycle: succeeded
status: completed
started_at: 2026-05-12T11:00:00Z
ended_at: 2026-05-12T11:30:00Z
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
completion_note: |
  Folded into ADR-087 (local-solo collapse). The /invite flow, invitation
  tokens, TokenStore, redeem helpers, agent-spawn endpoint, and the
  invitation test file were all deleted — not preserved as a deprecated
  branch. Agent self-service (/agents/new) also went away because the
  hosted-multi-tenant scaffolding it depended on is gone. The "no
  back-compat pre-v1" principle held: delete, don't shim.
---

# Backlog — no backward compat pre-v1.0

## The principle

While `schema_version` stays at `0.x`, no code path is owed a
deprecation window. New supersedes old immediately. We delete instead
of feature-flag.

This is the code-side analog of the schema-versioning policy in
[ADR-050](../decisions/decision_01KR441EA4F19H61WSEDAYAHVH.md). The
schema policy says minor version bumps need migration tooling and
back-compat reads. Code paths in pre-1.0 don't get the same
courtesy — there's no installed base to protect, and carrying twin
implementations slows learning.

## What's in scope today

The only meaningful back-compat surface in the repo right now is the
**invitation flow** (`/invite`, `POST /api/v1/invitations`,
`POST /api/v1/invitations/redeem`, `doco invite create`,
`doco agent register`). It was kept "for backward compat" when ADR-071
shipped the role-based `/agents/new` flow — but there's no installed
base. Delete it.

See `outputs.expected.sweep_targets` above for the file list.

## What stays

- **Decisions ADR-035..040, ADR-068..070** — Decisions are append-only
  history. Even when superseded, they document why we tried what we
  tried. A future ADR-073-or-similar can supersede them by
  cross-reference; the original prose stays.
- **`TokenStore` session-token logic** + revocation cascade. Still used
  by `/agents/new` and `POST /api/v1/agents/spawn`. The cleanup
  removes the *invitation-token* branch of the discriminator; sessions
  remain.
- **The `InvitationToken` lessons** — single-use semantics + 5-minute
  TTL + strict-cascade revocation are good ideas. They're not deleted
  because they're wrong; they're deleted because they're attached to a
  ceremony we no longer run. If we need them back later (for a
  different feature), reach into git history.

## When to pick this up

Whenever the next person touching the auth/principal code feels like
it. Not blocking; not urgent. The benefit is mostly: less surface to
read, fewer obsolete tests to maintain, less drift between docs and
code.

A reasonable trigger: the next time we change something in `auth.ts`
or `server.ts`, do the cleanup as a precursor commit.

## Anti-patterns to watch for

- Don't add `@deprecated` decorators or "kept for compat" comments.
  Either the code is live or it's gone. v0 has no in-between.
- Don't add feature flags to gate "old vs new" flows. If the old is
  superseded, delete it.
- Don't add migration scripts for code paths (schema migrations are
  different — those follow ADR-050).

## Generalization

This Action's broader reach: when an ADR supersedes a previous one,
the implementation it replaces should be deleted in the same change
or the very next one. Carrying both is the default mistake.
