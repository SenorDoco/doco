---
id: intent_01KR441EA0A03700ACK4MPN9EB
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Multi-tenant host: anyone can create an Evalo; Users create Organizations; Evalos can be owned by Users or Organizations. Local-first; same codebase deploys publicly later."

slug: multi-tenant-host
title: Multi-tenant host (GitHub-shaped)
priority: p0
parent_intent_id: null

non_goals:
  - "Replace per-Evalo git semantics. Each Evalo remains its own git repository (D-002)."
  - Force every project to register with a host. Standalone single-Evalo dirs (like this very repo) still work.
  - Build SSO / SAML / role-based-access-control beyond what GitHub-style {owner, member, viewer} supports.

acceptance:
  - "`evalo host init <path>` creates a host directory containing host.yaml + principals/ + organizations/ + evalos/ + schema/."
  - "`evalo host user create <username>` registers a host-level User Principal."
  - "`evalo host org create <slug> --owner <username>` registers an Organization owned by a host User."
  - "`evalo host evalo new <owner>/<slug>` creates a new Evalo at evalos/<owner>/<slug>/, owned by either a User or an Organization."
  - "`evalo host list` shows all Evalos (and their owners) registered in the host."
  - The web app, given a host directory in EVALO_ROOT, lists Evalos at `/` and scopes per-Evalo routes at `/:owner/:slug/...`.
  - Single-Evalo mode (existing /Users/torrenegra/Evalo) continues to work unchanged when the root has `evalo.yaml` not `host.yaml`.

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
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# Multi-tenant host (GitHub-shaped)

Reframes Evalo from "single project = single Evalo on a single filesystem"
to "host = many Evalos, each owned by a User or Organization." Mirrors
GitHub's `<owner>/<repo>` URL shape with `<owner_slug>/<evalo_slug>`.

The host runs locally first — anyone can `evalo host init ~/my-host` and
get a working multi-Evalo workspace. Once the model is proven, the same
codebase deploys publicly (Phase 6 / `evalo.to`) per ADR-053.

## What changes

- New entity type: `Organization` (host-level groups owning Evalos).
- `Evalo.owner_id` becomes polymorphic: `principal_<ulid>` OR `organization_<ulid>`.
- New filesystem layout for hosts: `host.yaml` + `principals/` + `organizations/`
  + `evalos/<owner>/<slug>/` + shared `schema/`.
- New CLI subcommands under `evalo host *`.
- Web app gains a host-mode (lists Evalos, scopes routes by owner+slug);
  single-Evalo mode preserved when root has `evalo.yaml` instead of
  `host.yaml`.

## What does NOT change

- Per-Evalo behavior: each Evalo continues to validate, lint, query, check,
  serve as before.
- The framework's self-hosted meta-Evalo at `/Users/torrenegra/Evalo` keeps
  running in single-Evalo mode (host functionality is opt-in).
- Auth model: same `--as-principal` for local dev; GitHub OAuth still deferred
  to Phase 6.
