---
id: intent_01KR441EA0A03700ACK4MPN9EB
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Multi-tenant host: anyone can create an Doco; Users create Organizations; Docos can be owned by Users or Organizations. Local-first; same codebase deploys publicly later."

slug: multi-tenant-host
title: Multi-tenant host (GitHub-shaped)
priority: p0
parent_intent_id: null

non_goals:
  - "Replace per-Doco git semantics. Each Doco remains its own git repository (D-002)."
  - Force every project to register with a host. Standalone single-Doco dirs (like this very repo) still work.
  - Build SSO / SAML / role-based-access-control beyond what GitHub-style {owner, member, viewer} supports.

acceptance:
  - "`doco host init <path>` creates a host directory containing host.yaml + principals/ + organizations/ + docos/ + schema/."
  - "`doco host user create <username>` registers a host-level User Principal."
  - "`doco host org create <slug> --owner <username>` registers an Organization owned by a host User."
  - "`doco host doco new <owner>/<slug>` creates a new Doco at docos/<owner>/<slug>/, owned by either a User or an Organization."
  - "`doco host list` shows all Docos (and their owners) registered in the host."
  - The web app, given a host directory in DOCO_ROOT, lists Docos at `/` and scopes per-Doco routes at `/:owner/:slug/...`.
  - Single-Doco mode (existing /Users/torrenegra/Doco) continues to work unchanged when the root has `doco.yaml` not `host.yaml`.

stakeholders:
  - principal_01KR441EA199MZCP7RDMADFZW9
  - principal_01KR441EA259F7EE420Z4VWFPJ

applies_to:
  any_of:
    - tag: scope_meta

created_at: 2026-05-08T18:30:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: active
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# Multi-tenant host (GitHub-shaped)

Reframes Doco from "single project = single Doco on a single filesystem"
to "host = many Docos, each owned by a User or Organization." Mirrors
GitHub's `<owner>/<repo>` URL shape with `<owner_slug>/<doco_slug>`.

The host runs locally first — anyone can `doco host init ~/my-host` and
get a working multi-Doco workspace. Once the model is proven, the same
codebase deploys publicly (Phase 6 / `doco.to`) per ADR-053.

## What changes

- New entity type: `Organization` (host-level groups owning Docos).
- `Doco.owner_id` becomes polymorphic: `principal_<ulid>` OR `organization_<ulid>`.
- New filesystem layout for hosts: `host.yaml` + `principals/` + `organizations/`
  + `docos/<owner>/<slug>/` + shared `schema/`.
- New CLI subcommands under `doco host *`.
- Web app gains a host-mode (lists Docos, scopes routes by owner+slug);
  single-Doco mode preserved when root has `doco.yaml` instead of
  `host.yaml`.

## What does NOT change

- Per-Doco behavior: each Doco continues to validate, lint, query, check,
  serve as before.
- The framework's self-hosted meta-Doco at `/Users/torrenegra/Doco` keeps
  running in single-Doco mode (host functionality is opt-in).
- Auth model: same `--as-principal` for local dev; GitHub OAuth still deferred
  to Phase 6.
