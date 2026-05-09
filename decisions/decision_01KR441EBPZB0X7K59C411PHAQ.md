---
id: decision_01KR441EBPZB0X7K59C411PHAQ
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Agents cannot self-create accounts. Every agent Principal is created via an invitation token issued by a human (or transitively by an agent in a chain ending at a human)."

slug: agents-via-invitation-only
number: "ADR-035"
intent_ids:
  - intent_01KR441EACJYB895DWKG7Z25SF
question: "How are agent Principals created?"
chosen: |
  Every agent Principal is created via an invitation token issued by a
  human (or transitively by an agent that was itself invited by a human).
  This invariant — *every agent traces back to a human invitation* — is
  the core trust property of the system, enforceable by walking
  `Principal.owner_id` and asserting termination at `type: human`.
alternatives:
  - name: Agent self-signup
    rejected_because: "No human accountability for agent actions. Chain breaks; lints can't enforce trust invariant."
rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0   # agent-ancestry-terminates-at-human
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-035 — Agents can only be created via invitation tokens

Operationalized as
[rule_01KR441EAJCPF378ZGM9DMDFH0](../rules/rule_01KR441EAJCPF378ZGM9DMDFH0.md)
(agent-ancestry-terminates-at-human, `phase: invariant`).

Reference: PLANNING.md §2.2, §3.
