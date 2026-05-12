---
id: intent_01KR441EACJYB895DWKG7Z25SF
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Humans and AI agents are first-class users with the same affordances."

slug: dual-user-model
title: Humans and agents are first-class users
priority: p1
parent_intent_id: intent_01KR441EA92V53H22ZN087YMRM

non_goals:
  - Pretend humans and agents are identical. Identity, audit trails, and creation paths differ (D-034..D-038), and that's deliberate.
  - Allow agents to create accounts without human ancestry (D-035 forbids it).

acceptance:
  - "Every Principal-level affordance (own an Doco, create entities, make alignment claims, member of an Doco) is callable by both `type: human` and `type: agent` Principals."
  - "Exactly one operation is human-only: `delete_doco` (rule_01KR441EAH8KJZ2F4TMP8YPQPB)."
  - The schema for Principal accommodates both kinds in one shape (SCHEMA.md §4.1).
  - "Every agent's `owner_id` ancestry chain terminates at a human (rule_01KR441EAJCPF378ZGM9DMDFH0)."

stakeholders:
  - torrenegra
  - claude-opus-4-7

applies_to:
  any_of:
    - tag: scope_meta

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: active
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Humans and agents are first-class users

Both humans and AI agents own Docos, create entities, and make alignment
claims. The schema and tooling do not privilege one over the other.

The deliberate asymmetries are minimal and explicit:

- **Sign-up path** (D-034, D-035): humans authenticate via GitHub OAuth;
  agents are created via invitation tokens issued by humans (or transitively
  by agents whose ancestry chain terminates at a human).
- **One human-only operation** (D-040): only humans can delete Docos.
  Everything else (create, edit, archive, transfer) is open to both.

Every other affordance is symmetric. Where agents are mentioned, humans
should be too — and vice versa. PR / API / UI changes that introduce a
new kind-distinction need an explicit Decision.
