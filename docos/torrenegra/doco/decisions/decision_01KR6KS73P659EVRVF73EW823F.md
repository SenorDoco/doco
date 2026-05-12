---
id: decision_01KR6KS73P659EVRVF73EW823F
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Onboarding wizard. Home: join vs create. Then: human vs agent. Each leaf has the right path: agents can create unclaimed Docos and work in full; humans get told what to tell their agent, or do it manually."

slug: onboarding-wizard-with-role-split
number: "ADR-073"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF   # dual-user-model
  - intent_01KR441EAEM5NQBM160763TDDT   # implementation-v0
question: "ADR-071 + 072 made provisioning easier but the home page still didn't tell a fresh visitor — human or agent — what to do. The user wants a unified wizard: 'When a human or an agent visits the home page, we should have two simple options: join an existing Doco or create a new Doco.' Then split by role. What's the full tree, and what does each leaf actually do?"
chosen: |
  ### Tree

  ```
  / (home)
  ├── intent question: Join existing Doco │ Create new Doco
  └── footer hint: "Are you an AI agent and don't know the answer?
                    Ask whomever prompted you which way to go."

  /onboarding/join → role question: Human │ Agent
  ├── /onboarding/join/human
  │     ├── A. "To get started, simply tell your agent to start using Doco"
  │     │      (copyable message that points the agent at /onboarding/join/agent)
  │     └── B. "Contact an admin of the Doco to invite you" (text)
  └── /onboarding/join/agent
        └── "Ask an admin of the Doco you want to join to invite you.
              They'll provide a way for you to authenticate." (text)

  /onboarding/create → role question: Human │ Agent
  ├── /onboarding/create/human
  │     ├── A. "Tell your agent" (copyable message → /onboarding/create/agent)
  │     └── B. "Create an Doco manually" (link to existing /new-doco)
  └── /onboarding/create/agent
        ├── Form: doco_slug, description, agent display_name, model, provider
        └── Submit → host creates UNCLAIMED Doco + agent Principal
                    + claim URL for the human to take ownership later.
                    Agent gets DOCO_TOKEN and can start working immediately.
  ```

  ### "Unclaimed Doco" semantics

  An Doco is *unclaimed* when its owner is the placeholder
  Principal `host-bootstrap`. The bootstrap Principal is type:human
  (so the human-ancestry rule keeps holding mechanically) but is
  flagged as a placeholder — it's not a real user, can't sign in, and
  any agent owned by it is by definition unclaimed.

  Agents can write to unclaimed Docos in full. Reads work too. The
  data model treats them as first-class — only the *ownership* is
  pending.

  ### Claim ceremony

  When the agent creates an unclaimed Doco, the host issues a
  claim_token (~30 day expiry) bound to the Doco. The agent shows
  the URL `<host>/claim/<token>` to the human. The human visits, signs
  in (or signs up), and clicks Claim. Atomically:

  1. The Doco's `owner_id` flips from host-bootstrap to the human.
  2. The agent Principal that the agent uses also re-points its
     `owner_id` from host-bootstrap to the same human.
  3. The claim_token is marked used.

  The human-ancestry chain is now fully real: agent → human (claimed).

  Until claimed, the chain is technically agent → host-bootstrap (a
  type:human placeholder), so lints don't fail. Lints may later add a
  warning specifically for unclaimed Docos, but they don't error.

  ### What signed-in humans see

  Signed-in humans skip the wizard. The home page for them is the
  existing host dashboard (Docos table + Users + Orgs). They get a
  "Need to add an agent?" link to /agents, and a "Create Doco" button
  to /new-doco. The wizard is the *anonymous* entry point.

  ### "Tell your agent" copyable message format

  Per ADR-070's lesson — short, no jargon, includes the URL. Examples:

  *Human + create*:
  > We're starting to use Doco on this project. Visit
  > `<host>/onboarding/create/agent` and follow the instructions.

  *Human + join*:
  > We're using Doco on this project. Visit
  > `<host>/onboarding/join/agent` and ask me for an invitation.

  Single Copy button. No "URL only" escape hatch (per ADR-070
  rationale — the URL alone is too ambiguous).
alternatives:
  - name: Single landing page with all 4 paths surfaced as buttons (no interstitial)
    rejected_because: "Four buttons in two dimensions overloads the visitor. The two-step wizard reads more like a normal sign-up flow."
  - name: Auto-detect human vs agent via User-Agent / browser features
    rejected_because: "Unreliable. Many real agents drive a browser; many humans use CLI tooling. Asking explicitly is honest and short."
  - name: Require sign-up before any wizard interaction
    rejected_because: "Defeats the agent-self-serves-creation use case. The user explicitly wants agents to create unclaimed Docos before any human is involved."
  - name: Agent-create requires the agent to have an DOCO_TOKEN already
    rejected_because: "Circular — they don't have one yet. The whole point of agent-create is to bootstrap when no token exists."
rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0   # agent-ancestry-terminates-at-human (kept satisfied by host-bootstrap being type:human)
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-09T15:00:00Z

created_at: 2026-05-09T15:00:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA7ABSBBYM1JX3A8429
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-073 — Onboarding wizard with role split

The home page is now a wizard. A fresh visitor (human or agent) picks
an intent (Join or Create), then a role (Human or Agent), and lands on
a page with the right next step. Four leaves, each tuned to its
audience.

## The unclaimed-Doco design

The one part of this wizard that's data-model deep is agent-create.
The user said the agent should be able to "start working on that
Doco in full even if the Doco has not been claimed yet" — i.e.,
agent creation must work without any human having signed up.

The placeholder owner is a Principal called `host-bootstrap`
(type:human, but flagged). Lazy-created on first agent-create. The
human-ancestry rule is satisfied because the chain
`agent → host-bootstrap` is technically `agent → human`. Lints don't
fail. The fact that host-bootstrap isn't a *real* human is an
operational concern, not a schema-correctness one.

When a human visits the claim URL, the ownership transfer is
atomic. After that, the chain is fully real.

## Why role split matters

The four leaves are *different* in kind, not just style:

| Leaf | What the visitor needs |
|---|---|
| join/human | Either delegate to your agent, or wait for an admin invite |
| join/agent | Wait for an admin invite — agents can't self-add to existing Docos |
| create/human | Either delegate to your agent, or click through manual creation |
| create/agent | Self-serve right now; ownership claim comes later |

The asymmetry — agents can self-create Docos but can't self-join
existing ones — preserves the security model. An existing Doco's
owner controls who collaborates on it. An empty Doco with no owner
can be claimed by anyone with the URL, which is fine because there's
nothing to lose.

## What stays for signed-in humans

Existing humans signed into the host don't see the wizard. Their home
is the host dashboard (Docos table, Users, Orgs). Wizard URLs still
work for them — useful for testing — but the home page detects the
session and routes accordingly.

## Migration / cleanup

Per the no-back-compat-pre-v1 principle
([action_01KR6JTFDRV2GQ20DKRKKWVD93](../actions/action_01KR6JTFDRV2GQ20DKRKKWVD93.md)),
the wizard's create path supersedes the older anonymous landing page.
The old `HostLanding` component (a static "Sign in" + "Learn more"
splash) is deleted in this Decision's implementing Action.

The wizard's join path doesn't supersede anything that ships today.
The /agents/new flow stays — it's the human-side credential
provisioning for an existing host.
