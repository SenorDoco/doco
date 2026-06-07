# Proposal: User-level MCP credential + one-workspace-per-session

> **Status: Proposed — direction confirmed by the project owner, not yet
> implemented.** The shape below (a user-level durable credential, with each
> *session* confined to one workspace) is the agreed target. Two design forks
> were decided by the owner: enforcement is **both-layered** (protocol invariant
> *and* host-enforced single-workspace access token), and the per-session
> workspace is selected **connections.md-default, tool-override**. This file is
> the design record and the sequencing plan; it describes what we intend to
> build, not what exists today. It supersedes the reasoning in
> `decision_01KS14CW9ZN23FF5CGG0Z7TH4G` ("no app-wide /mcp, for security") — see
> [Security](#security-why-this-can-reverse-the-old-decision).

## TL;DR

- Today the "one workspace" limit is a **hard credential boundary**: the MCP
  endpoint is `POST /<workspace-id>/mcp`, and `assertSingleWorkspaceGrant`
  refuses to mint any token touching more than one workspace. One connector per
  workspace = friction.
- We want the **GitHub model**: one durable credential authorizes *many*
  workspaces (everything the user can reach), but a working **session** acts on
  exactly **one** — and which one is decided by *context*, not the credential.
  Multiple docos *within* that one workspace are fine.
- The move is to **relocate the single-workspace invariant from the credential
  to the session**: the durable refresh/actor credential becomes user-level; the
  per-session access token stays single-workspace (keep
  `assertSingleWorkspaceGrant` on the *access* token, unchanged).
- Every agent surface already acts **as the user** and already has a natural
  "session anchor" — the MCP connection, the in-page conversation, the Slack
  channel. Two of the three are already single-workspace; the work is to make
  the anchor authoritative and consistent across all of them.

## Motivation & today's state

| Concern | Today |
|---|---|
| MCP endpoint | `POST /<workspace-id>/mcp` (`$workspaceId.mcp.tsx`), gated by `gateWorkspaceMcp()` which 403s a token bound to a different workspace |
| Token scope | `assertSingleWorkspaceGrant()` (`oauth-server.server.ts`) — a token grants **≤1** workspace, enforced at every mint |
| Resource binding | `.well-known/oauth-protected-resource/<workspace-id>/mcp`; the workspace id is the RFC 8707 audience |
| Identity | the token/cookie carries a `user_id`; the agent acts **as that user** |
| Rationale | `decision_01KS14CW9ZN23FF5CGG0Z7TH4G`: *"There is NO app-wide /mcp (removed for security)… a token reaches no other workspace."* |

The friction: a user with N workspaces installs N connectors and approves N
OAuth grants. We want one connection that reaches all of them, disciplined to
one workspace per session.

## Key insight: relocate the single-workspace invariant

GitHub's model is *credential broad, working-scope narrow and context-pinned*: a
PAT authorizes many repos/orgs, but a session works one repo, determined by the
checkout. Doco today is the **inverse** — it narrows the credential so there's
nothing to confine per session.

So: **widen the credential to the user, narrow the session.**

| Layer | Today | Proposed |
|---|---|---|
| Durable credential (refresh / pinned env var) | bound to one workspace | bound to the **user** — an *actor* grant: every workspace the user can reach, at their roles, live |
| Access token (per session) | single-workspace (the same one) | single-workspace, **which one chosen per session** |
| Who picks the workspace | fixed at mint | resource indicator at connect — default from `connections.md`, override via `doco_select_workspace` |
| `assertSingleWorkspaceGrant` | on every token | **unchanged, on the access token** |

The breadth lives on the refresh/actor credential; each minted access token is
still single-workspace. The existing security machinery is reused verbatim, one
layer up.

## The "session anchor" per surface (mostly already exists)

| Surface | Identity | Session anchor | Single-workspace today? | Bootstrap path |
|---|---|---|---|---|
| MCP connector | OAuth token's user | the connection | ✅ token bound to 1 ws | shared `agent-bootstrap.server.ts` |
| In-page Señor Doco | cookie (signed-in user) | the **conversation** (1:1 with a doco) | ✅ already hard-scoped — `buildBootstrapContext(user, ws)` shows no cross-workspace leak; `set_thread_workspace` is the override; `needsWorkspaceChoice` nudges when ambiguous | shared |
| Slack Señor Doco | bot token; writes run as the linked user, capped at their role | the **channel** (bound to 1 workspace at install) | ✅ channel→one workspace | ❌ its own hardcoded `slackLlmSystemPrompt`, **not** the shared bootstrap |

Identity is already uniform — every surface acts as the user. The selection
mechanism *generalizes*: **anchor default, override tool** —
`connections.md`/`doco_select_workspace` for MCP, the conversation /
`set_thread_workspace` for in-page, the channel for Slack.

## Enforcement: both-layered (decided)

1. **Protocol** — a new invariant in `CANONICAL_INSTRUCTIONS`: *"Your credential
   may reach many workspaces; you operate within exactly one per session — the
   one in `.doco/connections.md`. Multiple docos within it are fine. To touch
   another workspace, start a new session."*
2. **Host backstop** — bootstrap and tool calls are confined to the session's
   workspace server-side: the per-session access token is single-workspace, and
   `inWorkspace()` refuses cross-workspace calls (keyed to the session's selected
   workspace instead of the URL param).

## Selection: connections.md default, tool override (decided)

1. `.doco/connections.md` carries the workspace and is authoritative when
   present; add a lint that every doco it lists belongs to **one** workspace.
2. `doco_select_workspace` (a new tool) is the fallback for untracked dirs or an
   explicit switch; once pinned, switching requires a new session.

## Security: why this can reverse the old decision

`decision_01KS14CW9ZN23FF5CGG0Z7TH4G` removed app-wide MCP so a token couldn't
become "a master key to everything a human can reach." Here the durable
credential *is* broad — **but no single session can cross workspaces**
(host-enforced via the single-workspace access token). The master-key risk is
contained at the **session** boundary instead of the **credential** boundary,
and connection friction drops to one-per-user. This is a deliberate, recorded
supersession — not a silent reversal. The new decision should state: *the hard
guarantee is "a session cannot cross workspaces," and the durable credential is
least-privilege by role.*

## Auth / UX screens that change (all assume per-workspace scoping today)

| Screen | File | Current copy → needs |
|---|---|---|
| Token mint | `tokens.tsx` | *"Pick at least one workspace or doco to scope this key to"* → add a **user/actor** option ("reaches all your workspaces; sessions pin one") |
| Device approval | `device.tsx` + `approval-grants.ts` | consent must show the **broadened actor scope** *and* the **session-confinement mitigation** — the most security-sensitive copy |
| Onboarding | `$docoHandle.onboarding.agent.tsx` | *"Tokens are scoped per workspace / doco"* → "install once, reach all your workspaces" |
| MCP endpoint page | `$workspaceId.mcp.tsx` | *"bound to a single Doco Workspace… token reaches no other"* → user-level + per-session confinement |
| Slack link | `integrations.slack.link` | *"only within the workspace this team is connected to"* → reconcile with user-level reach |

## Test matrix

- **API · real-DB (PGlite)**: actor-refresh → single-workspace access-token
  exchange; `assertSingleWorkspaceGrant` stays green on the access token;
  bootstrap scoped to the selected workspace. *(extend the oauth + agent-bootstrap tests)*
- **MCP**: generalize `$workspaceId.mcp.test.ts` for the user-level endpoint —
  session-workspace from a `connections.md`-supplied resource vs
  `doco_select_workspace`, and **cross-workspace refusal**.
- **Website in-page · real-DB**: extend `agent-loop.real-db.test.ts` /
  `agent-chat-doco-scope.real-db.test.ts` to assert a conversation **cannot**
  read another workspace's constitution/docos (largely guarded already).
- **Slack · real-DB**: assert channel binding drives the **shared** bootstrap
  (not the hardcoded prompt); stub the Slack API as the existing slack tests do.
- **Website E2E**: extend `scripts/verify-live.mjs` (production dev-signin) —
  mint an actor token, prove a session is pinned to one workspace, and that a
  cross-workspace call is refused.

## Phased plan (each phase ships green on its own)

0. **Protocol + shared "session workspace" concept** — canonical invariant;
   `connections.md` carries the workspace + single-workspace lint. *(cheap,
   behavioral; lands meaning only once the credential can be broad, so it pairs
   with Phase 2)*
1. **Host-side confinement core** — one "scope bootstrap + tools to a workspace"
   helper; wire **Slack** onto it (kill the divergent hardcoded prompt) and
   confirm/tighten **in-page** (already hard-scoped). *Fixes the Slack
   divergence; no token change.*
2. **Actor credential + per-session single-workspace access token** — the OAuth
   surgery: `oauth-server.server.ts`, the OAuth tables, the refresh→access
   exchange takes a `resource`/selected-workspace validated against the actor's
   reachable set.
3. **User-level MCP endpoint** — `/me/mcp` (token-identified) + per-user
   `.well-known` + the `doco_select_workspace` tool; confine tools via
   `inWorkspace()` keyed to the session workspace. Keep `/<workspace-id>/mcp`
   alive during transition.
4. **Auth / onboarding UX** — the five screens above.
5. **Migrate + supersede + E2E** — point the bundled client / `.mcp.json` /
   templates at `/me/mcp`, retire the per-workspace endpoint, extend
   `verify-live.mjs`, and write the superseding decision vs
   `decision_01KS14CW9ZN23FF5CGG0Z7TH4G`.

## Non-goals / open questions

- **Non-goal:** cross-workspace operations *within* a single session. That stays
  impossible by design — the whole point.
- **Open:** endpoint shape — `/me/mcp` vs `/mcp` (token-identified) vs
  `/u/<user-id>/mcp`. Detail; pick in Phase 3.
- **Open:** how aggressively to deprecate the per-workspace `/<workspace-id>/mcp`
  endpoint vs keep it as an alias indefinitely.
