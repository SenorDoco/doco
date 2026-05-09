---
id: decision_01KR441EA28XBT5BRN2KMM1EDD
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Add `Organization` as the 11th node type. Existing `Principal` keeps unifying humans + agents; Organizations are groups (typically of human Principals) that can own Evalos."

slug: organization-as-11th-node-type
number: "ADR-062"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "What entity type represents 'a group of users that can own Evalos' — a new top-level kind, an extension of Principal, or an inline edge?"
chosen: |
  New top-level node type `Organization`. Joins the existing 10 (D-009) as
  the 11th kind. Schema:

  ```yaml
  id: organization_<ulid>
  evalo_id: evalo_<ulid>            # the host's "self-Evalo" or the Evalo this Org is mentioned in
  node_type: organization
  schema_version: "0.1"
  slug: anthropic                   # kebab-case, unique within host
  display_name: Anthropic
  description: "..."
  summary: "..."
  visibility: private | public
  members:
    - principal_id: principal_...
      role: owner | admin | member | viewer
      permissions: [read, write, execute, admin]
  created_at, created_by, lifecycle, status, tags  (common fields)
  ```

  `Membership` does NOT become its own entity — Organization.members[]
  inline (matching the precedent set by Evalo.members[] in D-011).
alternatives:
  - name: "Reuse Principal with type='organization'"
    rejected_because: "Principal.type is currently {human, agent}. Adding 'organization' conflates 'identity that acts' (humans/agents take Actions) with 'group that owns' (orgs don't act, but their members do). Cleaner to keep them distinct."
  - name: First-class Membership entity
    rejected_because: "Same reasoning as D-011 (Membership-as-edge for Evalo.members[]). Memberships rarely have an independent lifecycle worth a node."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T18:30:00Z

created_at: 2026-05-08T18:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-062 — Organization as the 11th node type

Updates the node-type list to 11 (was 10 per ADR-009). All other places
that enumerate node types (the JSON Schema's pattern, the index migrations,
the @evalo/shared NODE_TYPES tuple) need to be updated in the implementation
Action.

Filesystem location: `<host-root>/organizations/organization_<ulid>.yaml`
in host mode, `<evalo-root>/organizations/` in single-Evalo mode (mostly
empty for self-owned Evalos like the meta-Evalo).
