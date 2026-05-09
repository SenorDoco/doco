---
id: decision_01KR441EA1X74DH9WBDY5Z6HQ6
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Introduce a Host concept: a directory that contains many Evalos plus host-level Principals and Organizations. Mirrors GitHub's owner/repo namespacing locally; deploys to the same model in Phase 6."

slug: multi-tenant-host-concept
number: "ADR-061"
intent_ids:
  - intent_01KR441EA0A03700ACK4MPN9EB
question: "How does Evalo support multi-tenancy ('anyone can create an Evalo, anyone can create an Organization') without breaking the single-Evalo model that the framework's own meta-Evalo uses?"
chosen: |
  A Host is a directory containing many Evalos. The framework supports two
  modes:

  - **Single-Evalo mode** (current): a directory has `evalo.yaml` at its root.
    Existing behavior preserved unchanged.
  - **Host mode** (new): a directory has `host.yaml` at its root and
    `evalos/<owner>/<slug>/` subdirectories — each subdirectory is itself a
    full single-Evalo (with its own evalo.yaml).

  Code paths (CLI / API / Web) detect which mode they're in by inspecting
  the root and switch routing/layout accordingly.

  Each Evalo inside a host is still its own potential git repo (D-002 still
  holds at the per-Evalo level). The host directory itself is a directory of
  directories — not a single git repo containing all Evalos.
alternatives:
  - name: One mega-repo containing all Evalos
    rejected_because: "Conflicts with GitHub's per-repo independence model. Forks, stars, public/private boundaries become awkward when many Evalos live in one git history."
  - name: Database-backed multi-tenant store (no per-Evalo filesystem)
    rejected_because: "Loses git-native version control per ADR-002. The point of file-per-entity is local-first portability."
  - name: Migrate the existing meta-Evalo to be inside a host
    rejected_because: "Disruptive — changes URLs, paths, every cross-reference. The dual-mode design lets the framework's own repo stay as-is while still building host functionality."
rules_consulted:
  - rule_01KR441EAF7M5QPF65BXGD1ET1
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

# ADR-061 — Multi-tenant Host concept (dual-mode)

The Host directory mirrors a GitHub instance:

```
<host-root>/
  host.yaml                          # Host config
  schema/
    evalo.schema.json                # shared by all Evalos in this host
  principals/
    principal_<ulid>.yaml            # host-level Users + cross-Evalo agents
  organizations/
    organization_<ulid>.yaml         # host-level Orgs
  evalos/
    <owner_slug>/
      <evalo_slug>/                  # full single-Evalo subtree (own evalo.yaml etc.)
        evalo.yaml
        intents/, rules/, decisions/, ...
        .evalo/cache.db              # per-Evalo SQLite cache
  .evalo-host/                       # host-level cache, gitignored (deferred)
```

Dual-mode detection (in @evalo/host + @evalo/web):

```ts
if (existsSync(path.join(root, "host.yaml"))) { mode = "host"; }
else if (existsSync(path.join(root, "evalo.yaml"))) { mode = "single-evalo"; }
else { throw new Error("not an Evalo or Host directory"); }
```
