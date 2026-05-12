---
id: decision_01KR6HJABS6GYHR9DXP4DZVRHR
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Role + session split for agent identity. Human directly creates a durable Principal{type:agent} (Role); sessions are ephemeral self-declared labels. No invitation ceremony — PAT-style provisioning."

slug: agent-role-and-session-split
number: "ADR-071"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "After ADR-068..ADR-070, the invitation flow still produced a refusal from a real receiving agent on three grounds: (1) it has no persistent identity for a token to bind to, (2) 'click-to-accept' on a localhost URL is phishing-shaped and a safety-trained agent should refuse, (3) localhost from another CLI session is unreachable. The objections are correct. What's the right semantic for agent identity in Doco?"
chosen: |
  Two-layer identity:

  1. **Role** (durable). A `Principal{type: agent}` owned by a human.
     Carries `display_name`, `agent_metadata.{model, provider, capabilities}`,
     `owner_id` → human. Lives until explicitly revoked. The artifact the
     human creates and configures.

  2. **Session** (ephemeral). A free-form identifier emitted by the
     agent itself with each request, e.g. `X-Doco-Session: <session_id>`.
     The host does not allocate session ids, does not manage their
     lifecycle, does not authenticate them — sessions are *labels*, not
     credentials. The agent decides what counts as a session (one
     conversation, one task, one boot, etc.).

  Auth is bearer-token, single layer: the DOCO_TOKEN is the role's
  credential. Sessions are an audit/grouping concept stamped onto
  Action and Reasoning records.

  Provisioning is a single-party ceremony, not a two-party handshake:

  - Human signs in, visits `/agents/new`, fills in display_name + model
    + provider + capabilities, clicks Create.
  - Host creates the `Principal{type: agent, owner_id: <human>}` and
    issues a long-lived session token (the DOCO_TOKEN) bound to it.
  - UI shows the token *once*, with a "store this — we won't show it
    again" warning and a copy button.
  - Human pastes the token into their agent's environment (`.env`,
    secrets manager, etc.) the same way they'd handle any API key.

  No URL is shared with the agent. No agent accepts anything. No
  redemption ceremony. The agent's job, when it runs, is to send its
  token + a session_id; the host records the action under
  `(principal_id, session_id)`.

  This subsumes the OAuth/PAT pattern that every comparable real-world
  system uses (GitHub PATs, AWS access keys, OpenAI API keys). The
  receiving agent's three objections from the brainstorm vanish:
  (1) the token is the durable identity, not the session — and the
  human is responsible for keeping it safe, not the agent;
  (2) the human creates the credential while signed into their own
  account, not by clicking through an unknown URL;
  (3) localhost is irrelevant because nothing about the agent's runtime
  needs to reach the host's web UI — the agent only hits the API with
  its bearer token.
alternatives:
  - name: A. Personal Access Token only (no Session concept)
    rejected_because: "Loses per-session audit. Two LLM sessions running on the same role's token would be indistinguishable in the trail. E preserves PAT simplicity at the auth layer while adding session_id as cheap audit metadata."
  - name: B. Pairing flow (6-digit Apple-TV-style code)
    rejected_because: "Two-party handshake assumes the agent has persistent CLI tooling that can survive the round trip. Stateless LLM sessions can't really pair — the next session won't know what was paired before. Better fit for daemon-style agents (cron, IDE plugins); revisit when those land."
  - name: C. SSH-keypair enrollment
    rejected_because: "Same problem as B — stateless agents don't have a keystore. Cryptographically nicer than bearer tokens for long-running agents, but premature for v0."
  - name: D. Drop type:agent entirely; everything attributes to humans
    rejected_because: "Loses the framework's namesake commitment (rule_agent_ancestry_terminates_at_human). The rule does work — it forces every action's chain to terminate at a human, which is exactly the audit invariant Doco exists to enforce. Vacuous-ifying it would weaken the framework's distinctiveness. Worth reconsidering separately if practice shows the rule isn't catching anything; not now."
  - name: F. Keep current invitation flow, reframe as 'human clicks while signed in'
    rejected_because: "Less disruptive but doesn't address the threat-model objection. The URL still looks phishing-shaped to anyone who didn't write the system. E removes the URL entirely from the agent's path, which is cleaner."
rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0   # agent-ancestry-terminates-at-human
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-09T14:10:00Z

created_at: 2026-05-09T14:10:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-071 — Role + session split for agent identity

## Why the previous design failed in practice

ADR-068 implemented the "invitation URL" flow specced in PLANNING.md.
ADR-069 made the URL self-describing once fetched. ADR-070 fixed the
share-message so a cold receiver had context. The user still hit a
real-world refusal:

> "I won't visit that link. (1) I can't act as a persistent agent on
> your behalf — I'm a CLI session. (2) One-click invite links are a
> phishing-shaped pattern. (3) It's a localhost URL."

All three objections are correct. The deepest is (2): we built a
ceremony in which the *agent* accepts an invitation on the human's
behalf. That's backwards. In every system that works (GitHub PATs,
AWS keys, OpenAI keys, SSH keys), the *human* creates the credential
and hands it to their tooling.

## What changes

| Concept | Before (ADR-068..070) | After (ADR-071) |
|---|---|---|
| How an agent's identity is created | Human issues a 5-min invitation URL; agent visits and "redeems" it; redemption mints a Principal{type:agent} + token | Human signs in, fills out a form, clicks Create. Principal + token come back immediately. Agent is uninvolved. |
| What the agent sees | A URL to click | An DOCO_TOKEN in its environment |
| Who accepts | The agent | The human (by clicking Create) |
| Per-session audit | None — all actions roll up to the agent's principal | `Action.session_id` + `Reasoning.session_id` carry the agent's self-declared session, recorded next to `created_by` |
| Threat model | "Click to accept" pattern (phishing-shaped) | PAT pattern (well-understood; humans handle the secret) |

## Data model deltas

### Principal{type: agent}

Unchanged. Still has `owner_id`, `agent_metadata`, etc. The role-vs-session
split lives at the *Action* layer, not at Principal. (Sessions are not
Principals; they're labels.)

### Action.session_id (new, optional)

Free-form string supplied by the agent at action-write time. Examples:

- `cc_<ulid>` — Claude Code session id
- `<conversation_id>` — chat-app conversation
- `<job_id>` — batch job

The schema accepts any non-empty string ≤128 chars. Optional. When
absent, audit groups by Principal alone (i.e., behaves like before).

### Reasoning.session_id (new, optional)

Same as Action.session_id. A reasoning record can be tagged with the
session that produced it.

## Endpoints (web — not API server)

The host's API server doesn't need to change for v0. The web has direct
file-IO access (TokenStore + addAgentPrincipal) and creates the role
itself.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/agents/new` | Form — display_name, model, provider, capabilities |
| `POST` | `/agents/new` | Creates Principal{type:agent} + DOCO_TOKEN; renders the token *once* |
| `GET` | `/agents` | Lists the human's owned agent Roles, with last-seen and revoke |
| `POST` | `/agents/:id/revoke` | Revokes the token (cascade per ADR-038) |

The old `/invite` flow keeps working for backward compat. It's no
longer the recommended path; the next ADR-or-Action can deprecate it.

## What stays the same

- **Human-ancestry rule**: `Principal{type:agent}.owner_id` still
  terminates at a human. The new provisioning ceremony preserves this
  trivially.
- **Strict-cascade revocation** (ADR-038): revoking a role's token
  cascades to any sessions and to spawned-agent Principals.
- **Spawn-as-credential-derivation**: a parent agent can still create
  a child Role via `POST /api/v1/agents/spawn`. Use case: a top-level
  agent delegates to a sub-tool and wants the sub-tool to have a
  distinct, independently-revocable identity.

## Migration path

1. Ship `/agents/new` + `/agents` UI alongside `/invite`. Both work.
2. Add `session_id` field to Action + Reasoning schemas (additive,
   optional — no migration of existing entities).
3. Update lints to allow but not require `session_id`.
4. Once telemetry shows nobody using `/invite`, hide it from nav and
   later remove the route.
5. The CLI's `doco agent register` keeps working — it's still a
   useful headless flow for the bootstrapping case where the human
   hasn't set up the web yet. But its docs reframe it: "Run this from
   a shell where you're already authorized as the human."

## What's deferred (not in this ADR)

- `session_id` schema field — additive change, separate Decision when
  the schema migration tooling lands. Until then, agents can stamp
  Actions with a `session_id` field that the validator treats as
  unknown-but-tolerated.
- Audit UI grouping by session — useful but not blocking. The data is
  already in the entity files; surfacing it is cosmetic.
- Sessions-as-first-class node_type — rejected for v0 (sessions are
  labels, not entities). Revisit if practice shows we need
  per-session lifecycle hooks (revoke, expire, etc.).
