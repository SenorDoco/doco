---
id: decision_01KR441EA3N0TXTKSNR3MYCKZ4
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Evalo.owner_id is polymorphic: accepts either a `principal_<ulid>` (user-owned) or an `organization_<ulid>` (org-owned). Validation enforces one of the two."

slug: evalo-owner-polymorphism
number: "ADR-063"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "How does an Evalo's owner field represent 'this is owned by a User OR an Organization'?"
chosen: |
  Single field `owner_id`, polymorphic across `principal_<ulid>` and
  `organization_<ulid>`. The schema's id-pattern already accepts
  `(principal|organization|...)_[ULID]`; relax the `owner_id` JSON-Schema
  ref from `principal_id` to a union.

  Implementation pattern in code:

  ```ts
  type OwnerRef = EntityId<"principal"> | EntityId<"organization">;
  function ownerKind(id: OwnerRef): "principal" | "organization" {
    return id.startsWith("principal_") ? "principal" : "organization";
  }
  ```

  URL shape: `/:owner_slug/:evalo_slug`. The slug resolves to either a
  Principal.username (humans) or Organization.slug (orgs); collisions are
  prevented by enforcing one shared slug namespace per host (D-064).
alternatives:
  - name: Two fields (`owner_principal_id`, `owner_organization_id`); exactly one set
    rejected_because: "Forces every consumer to check both fields. Polymorphic single field is what GitHub does internally and what the URL shape implies."
  - name: Force all Evalos to be owned by a synthetic Principal that wraps an Organization
    rejected_because: "Adds an indirection layer with no payoff. The org-owned URL `<org>/<repo>` should resolve directly to the Org, not a fake Principal."
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

# ADR-063 — Evalo.owner_id polymorphic across Principal | Organization

Affects:
- `schema/evalo.schema.json`'s `evalo_entity.owner_id`: relax to
  `anyOf: [principal_id, organization_id]`.
- `@evalo/shared/entities.ts` `Evalo.owner_id` type: union.
- @evalo/host CLI when creating an Evalo: validates the owner exists and
  picks the right id prefix.
