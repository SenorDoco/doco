---
id: decision_01KR441EA4W857CKWRRWZNT2NW
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Within a host, Principal.username and Organization.slug share a single namespace — `<owner>/<evalo>` URLs resolve unambiguously."

slug: shared-owner-namespace-within-host
number: "ADR-064"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "Can a User and an Organization share the same handle within a host (e.g., user 'evalo' AND org 'evalo')?"
chosen: |
  No. Within a host, Principal.username and Organization.slug share a single
  flat namespace. Validation rejects creation if the requested slug already
  belongs to another User or Organization.

  Mirrors GitHub: there is no user `vercel` AND org `vercel` on the same
  host — the slug is unique across both kinds.

  The `evalo host {user,org} create` commands check for slug conflicts
  before writing.
alternatives:
  - name: Separate namespaces for users and orgs
    rejected_because: "URL shape `/:owner/:evalo` would need disambiguation (`/u/<username>/...` vs `/o/<orgname>/...`). GitHub's flat namespace is more familiar."
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

# ADR-064 — Shared owner namespace within a host

Implementation: a tiny lookup helper in @evalo/host that, given a slug,
returns either `{kind: "principal", id, ...}` or `{kind: "organization", id, ...}`
or `null`. Used by the create commands and by URL routing.
