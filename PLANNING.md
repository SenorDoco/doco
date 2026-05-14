# Doco Product Planning — v0.1

Companion to [SCHEMA.md](SCHEMA.md). Where SCHEMA.md defines the data model, this document covers product flows, identity, collaboration, onboarding, and the API/Web surface.

## 1. Onboarding flows

Two distinct ways to start, plus a path to join an existing Doco.

### 1.1 Creating an Doco for a *new* project (greenfield)

The simple case — you don't have prior project history to absorb.

**CLI:**
```bash
doco init my-project
```

**Web:** *New Doco* → fill out the form (slug, display name, visibility, description) → *Create*.

**What you get:**
- Empty Doco with you as `owner` (and a `MemberOf` edge with role `owner`).
- Default `doco.yaml`, `glossary.yaml`, and entity directories scaffolded.
- Empty-state UI prompting for a first Intent (*"What is this project trying to achieve?"*).

**Next steps the UI guides you through:**
1. Declare your top-level Intents.
2. Add the first few `must`/`must_not` Rules (e.g., privacy, security, compliance).
3. Record Decisions as work begins.

### 1.2 Creating an Doco for an *existing* project (brownfield)

You have years of decisions, conversations, and code already. Doco asks one **critical question** before anything else:

```
Do you want to:
  (a) Document only decisions going forward
  (b) Backfill past decisions from prior context (Slack, email, code, docs, ...)
```

**If (a)** — same as greenfield from this point. Optionally tag the start with a `Decision(question: "Backfill scope?", chosen: "Forward-only")` so the choice is visible.

**If (b)** — enter the backfill workflow (§4).

**CLI:**
```bash
doco init my-project --existing
```

**Web:** *New Doco → For an existing project* → form → backfill choice → next-step wizard.

### 1.3 Joining an existing Doco

Two paths depending on whether the joiner is a person or agent.

**Person joining:**
- The Doco owner adds the person's GitHub login to `members[]` in `doco.yaml` (or via the web members page).
- The person visits the Doco URL while signed in via GitHub; access is granted automatically.

**Agent joining:**
- See §3 — invitation token flow.

## 2. Identity & authentication

### 2.1 Person accounts — GitHub-only

**People can only sign in via GitHub.** No email/password, no magic links. GitHub is the sole identity provider for people.

Why:
- GitHub is universal among the target user base (developers, teams adopting AI agents).
- Eliminates account-creation surface area (no password resets, no email verification).
- Aligns with the "Doco is a git-repo-equivalent" mental model.
- Locks identity to a verified external authority.

A person's `Principal.username` is their GitHub login. Display name and avatar come from the GitHub profile.

### 2.2 Agent accounts — invitation-only

**Agents cannot self-create accounts.** Every agent Principal is created via an invitation token issued by a person (or transitively by an agent that was itself invited by a person).

This invariant — *every agent traces back to a person's invitation* — is the core trust property of the system. It's enforceable by walking `Principal.owner_id` and asserting the chain terminates at a `type: person`.

### 2.3 Username convention

| Type | Username format | Example |
|---|---|---|
| Person | GitHub login | `torrenegra` |
| Agent | `{owner_username}/{creation_timestamp_ISO_8601}` | `torrenegra/2026-05-08T15:42:00Z` |

The timestamp is the moment the agent's `Principal` entity was created. Lineage is visible at a glance (*"this agent was spawned from `torrenegra` at this time"*), and multiple agents under the same owner get distinct usernames automatically without name collisions.

### 2.4 Permissions: person-only operations

The schema-level expression of "only people can delete Docos" is a built-in **system Rule** shipped with Doco:

```yaml
# Built-in system Rule (shipped with Doco, not user-editable)
id: rule_system_only_people_delete
modality: must
phase: pre
applies_to: { node_type: action, verb: delete_doco }
predicate: "actor.type == 'person'"
on_violation: block
summary: "Only person Principals may delete Docos"
```

All other operations (create, edit, archive, transfer, etc.) are open to both people and agents subject to their `permissions` list on the relevant Membership edge.

## 3. Agent collaboration via invitation tokens

A person invites an agent by sharing a URL with an embedded token. The token has a deliberate **two-phase lifecycle**: a short-lived **invitation token** that bootstraps a long-lived **session token**.

### 3.1 Two token types

| Token | Purpose | Expiry | Storable |
|---|---|---|---|
| **Invitation token** | First-time bootstrap; URL-shareable | **5 minutes** from issuance, single-use | No |
| **Session token** | Long-term agent access; environment-stored | **No default expiry** (revocable) | Yes — env var (`DOCO_TOKEN`), secrets manager |

### 3.2 Lifecycle

```
1. Person owner generates an invitation URL on the web UI:
     https://doco.dev/invite/{doco_slug}#token={short_lived_token}

2. URL shared out-of-band (Slack, email, paste).

3. Agent visits URL within 5 minutes:
     — Server validates the invitation token (single-use, not expired).
     — Agent self-introduces (display_name, model, provider).
     — Server creates a Principal{type:agent}:
         owner_id = inviter
         username = "{inviter_username}/{now_ISO}"
     — Server issues a SESSION TOKEN to the agent.
     — Server returns the session token in the response body.

4. Agent stores session token in the DOCO_TOKEN environment variable.

5. Future agents spawned by this agent (subagents, long-running runtimes, CI):
     — Inherit DOCO_TOKEN from environment.
     — Use it to create their own Principal:
         POST /api/v1/doco/{slug}/agents
         Authorization: Bearer {session_token}
         body: { display_name, model, provider, ... }
     — Server creates a new Principal{type:agent} with owner_id pointing to
       the invoking agent (preserving the person-ancestry chain).
     — Server issues each new agent its own session token.
```

### 3.3 Security properties

- **5-minute invitation window** — narrow enough that leaked invite URLs aren't valuable to typical attackers (the breach-to-exploit chain is too slow).
- **Session tokens never expire by default but are always revocable** by any person with `admin` permission on the Doco.
- **Revocation cascades** — revoking a session token invalidates all session tokens whose ancestry chain passes through it. (Default — strict. Alternative considered in §6.)
- **Audit trail** — each token issuance, use, and revocation produces an Action (`verb: issue_token`, `use_token`, `revoke_token`), visible in the Doco's history.
- **Tokens are stored in a secure store** (the API server's encrypted DB), never in the Doco's git repo. The Doco records *which* Principals exist and their lineage; token *values* live elsewhere.

### 3.4 The trust chain in the schema

Every agent's `Principal.owner_id` points at its inviter. Walking the chain back **always** terminates at a person. This is queryable:

```cypher
// Every agent's path back to a person
MATCH path = (a:Principal {type:'agent'})-[:OwnedBy*]->(person:Principal {type:'person'})
WHERE a.id = 'principal_agent_01H...'
RETURN path
```

A lint can periodically verify the invariant: no agent Principal has an ancestry chain ending in another agent.

## 4. Backfilling decisions from prior context

When you create an Doco for an existing project (§1.2 path b), Doco helps extract Intents, Decisions, and Reasoning from the trail of prior conversations and artifacts.

### 4.1 Sources Doco can extract from

| Source | Typical extracted entities |
|---|---|
| Agent ↔ agent conversations (transcripts, logs) | Reasoning chains, mid-task Decisions |
| Person ↔ agent conversations (Claude/ChatGPT/Gemini logs) | Intents (what the person asked for), Decisions (what was chosen), Reasoning (why) |
| Slack groups | Decisions made via thread discussion, Intents from kickoff messages |
| Slack channels (long-running) | ADR-equivalent threads, Decisions |
| Email threads | External-facing Decisions (vendor choices, contract terms) |
| Figma documents | Design Decisions, alternatives considered, comments-as-Reasoning |
| Design documents (Notion, Google Docs, Confluence) | High-level Intents, architectural Decisions |
| Code commits & PRs | Decisions inferable from PR descriptions; Rules inferable from CI configs and lint files |
| Linear / Jira / GitHub issues | Intents (the issue), Decisions (resolution comments) |

### 4.2 Extraction workflow (per source)

For each source, Doco provides an *importer* (CLI plugin or web wizard):

1. **Authenticate** — OAuth to the source where supported (Slack, GitHub, Figma, Google).
2. **Define scope** — pick which channels / threads / files / repos / time range to extract.
3. **Run extraction** — the importer summarizes each candidate artifact and proposes Doco entities.
4. **Each proposed entity carries a `Reference`** pointing back to the original source (Slack permalink, Figma comment ID, PR number, message ID) for traceability.
5. **Entities enter with `lifecycle: proposed`** — they don't appear in the active alignment graph until reviewed.

### 4.3 Per-source extraction patterns

- **Slack importer** — Slack OAuth → user picks channels/threads → importer runs an LLM summarizer that maps "decision-shaped" threads to Decisions, "goal-shaped" messages to Intents, and the surrounding discussion to Reasoning.
- **Email importer** — Gmail or IMAP OAuth → user selects threads matching keywords/labels.
- **Figma importer** — comments + version history → design decisions extracted from comment threads, with the Figma node as the target Reference.
- **Notion / Google Docs** — exported via API; document structure mapped (headings → Intents, decision sections → Decisions).
- **Code commits** — `git log --grep` patterns + GitHub PR API; PR descriptions parsed for "we chose X because Y" patterns.
- **Conversation transcripts** — agents and people paste/upload chat logs; the importer LLM extracts Decision/Reasoning candidates.

### 4.4 Review and accept

After extraction, the user lands in a **review UI**:

- Bulk filters (node type / source / time / confidence).
- Bulk-accept / bulk-reject affordances.
- Per-entity edit and grouping (combine related items into a Reasoning chain).
- **Accepted entities flip from `lifecycle: proposed` to `active`** (or `accepted` for Decisions).
- The user can mark backfill as "complete," establishing a baseline; from then on, new Decisions are tracked in real time.

Importer pipelines must be **idempotent and auditable**: re-running the same source with the same scope produces the same proposed entities. This is critical because users will iterate (refine the time range, add a channel, retry after edits).

## 5. API and web interface

### 5.1 API is primary; web is a consumer

The web interface is **not** a parallel implementation — it is a consumer of the public API. This guarantees:
- Anything a person can do, an agent can do.
- Anything a person can do is documented (the API IS the documentation).
- Feature parity is mechanical, not maintained by hand.

### 5.2 API surface

REST + JSON, with:
- Standard CRUD on every node type: `/api/v1/doco/{slug}/{node_type}/{id}`.
- Bulk endpoints for import / export.
- Query endpoint accepting SQL or Cypher (matches §8.6 of SCHEMA.md).
- Discovery endpoint (`POST /api/v1/doco/{slug}/find-rules` — matches §10.3 of SCHEMA.md).
- Streaming events feed (`GET /api/v1/doco/{slug}/events?since=...`).
- Auth endpoints for the invitation-token flow (§3.2).

OpenAPI schema served at `/api/v1/openapi.json`. Agents consume this directly — no separate SDK needed.

### 5.3 Web interface — recent changes is the home

Plain truth: graph navigation often **doesn't work well** for browsing. A node-edge spaghetti is not how people want to start their day. The graph IS the data structure, but it's a **secondary** view, not the primary navigation.

**Primary navigation:**
- **Recent changes feed** (the home view) — ordered list of Actions, Decisions, Evaluations across the Doco. Default last 7 days; filter by node type / actor / time. Mirrors the GitHub home dashboard, which users already understand. Surfaces alerting items inline (failed Evaluations, blocked Actions, drift warnings).
- **By node type** — list views for Intents, Decisions, Rules, etc., with filters and lifecycle pivots.
- **By tag** — tag pages aggregating everything tagged with a given tag (including the reserved `scope_*` tags).
- **Search** — Cmd-K palette + full search page (Postgres tsvector + semantic + scope-aware).

**Secondary navigation:**
- **Graph view** — accessed from any entity detail page ("show neighborhood"). Defaults to a **2-hop neighborhood** to avoid the spaghetti problem; filters to limit edge types (e.g., "only `Constrains`," "only `Serves`").
- **Lenses / saved views** — power users define filtered queries; pin to the nav.

**Principle:** the graph is data, not interface. List views + recent-changes feed + filtered queries cover most user intent. Graph is for explicit traversal, never the home.

### 5.4 Recent-changes feed — group modes

The feed groups items in three ways, user-toggleable:
- **By time** (newest first) — default.
- **By actor** (collapsing batches from the same agent into one expandable card).
- **By topic** (clustered by shared tags / scope).

Each item has a "view in graph" affordance — once-clicked-from, never primary.

## 6. Open product questions

1. **GitHub-only people — hard constraint or v0 simplification?** Locks out users without GitHub accounts (some PMs, many designers). If broader adoption matters, eventually need OIDC/SAML — but every alternative provider must still resolve to a verified external identity (no Doco-native passwords). Defer until adoption signal demands it.

2. **Token revocation cascade — strict or scoped?** Strict (proposed): revoking Alice's session token invalidates all agents whose ancestry passes through it. Scoped alternative: tombstone the owner, leave agents intact until their *own* tokens are revoked. Strict is safer; scoped is more forgiving. Going strict by default, with a per-Doco override flag.

3. **Backfill quality.** Extracted entities will be lossy and sometimes wrong. Default `lifecycle: proposed` keeps them out of the active graph until reviewed; require explicit acceptance to flip. A built-in Rule could even prevent backfilled entities from being Premises in active Reasoning until reviewed (lint/check).

4. **Public Docos and the trust chain.** If Docos can be public, anyone reads agent ancestry. Probably fine (just usernames + timestamps), but confirm no PII can leak via `Principal.identifier` or display names. Add a Rule: `display_name must not contain email patterns`.

5. **Graph-as-secondary-view risk.** Agreeing graph is hard, but a Rule-discovery tool that can't show "this Rule descends from this ADR's consequence" loses something. Compromise: expose graph as drill-down only, but make the *path-back-to-source* widget on every entity detail page (the alignment trace) very prominent.

6. **First-class Token entity?** Currently tokens are an API/server-side concept; Principals know their owner via `owner_id`, and the Doco records membership. We *don't* model `Token` as a node type in SCHEMA.md. Add only if token *metadata* (name, scope, revocation history) needs to be queryable inside an Doco. For now, keep external.
