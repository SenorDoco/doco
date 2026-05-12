---
id: decision_01KR441EA28XBT5BRN2KMM1EDD
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Add `Organization` as the 11th node type. Existing `Principal` keeps unifying humans + agents; Organizations are groups (typically of human Principals) that can own Docos."

slug: organization-as-11th-node-type
number: "ADR-062"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "What entity type represents 'a group of users that can own Docos' — a new top-level kind, an extension of Principal, or an inline edge?"
chosen: |
  New top-level node type `Organization`. Joins the existing 10 (D-009) as
  the 11th kind. Schema:

  ```yaml
  id: organization_<ulid>
  doco_id: doco_<ulid>            # the host's "self-Doco" or the Doco this Org is mentioned in
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
  inline (matching the precedent set by Doco.members[] in D-011).
alternatives:
  - name: "Reuse Principal with type='organization'"
    rejected_because: "Principal.type is currently {human, agent}. Adding 'organization' conflates 'identity that acts' (humans/agents take Actions) with 'group that owns' (orgs don't act, but their members do). Cleaner to keep them distinct."
  - name: First-class Membership entity
    rejected_because: "Same reasoning as D-011 (Membership-as-edge for Doco.members[]). Memberships rarely have an independent lifecycle worth a node."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-08T18:30:00Z
superseded_by: decision_01KREMDWG6SWKFHR5P1RDB64NC

created_at: 2026-05-08T18:30:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: superseded
status: superseded
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-062 — Organization as the 11th node type

Updates the node-type list to 11 (was 10 per ADR-009). All other places
that enumerate node types (the JSON Schema's pattern, the index migrations,
the @doco/shared NODE_TYPES tuple) need to be updated in the implementation
Action.

Filesystem location: `<host-root>/organizations/organization_<ulid>.yaml`
in host mode, `<doco-root>/organizations/` in single-Doco mode (mostly
empty for self-owned Docos like the meta-Doco).
