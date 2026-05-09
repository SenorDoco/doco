---
id: intent_01KR441EA92V53H22ZN087YMRM
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: intent
schema_version: "0.1"
summary: "Build an alignment framework that documents and verifies user intent ↔ agent reasoning ↔ agent actions."

slug: alignment-framework
title: Build an alignment framework
priority: p0
parent_intent_id: null

non_goals:
  - Be a project-management tool. (Adjacent, but different problem.)
  - Replace ADR repositories. (We can subsume them as Decisions, but the goal is alignment, not just documentation.)
  - Be language-specific or framework-specific.

acceptance:
  - "An Evalo can be created (`evalo init`), populated with intents, rules, decisions, and actions, and queried."
  - Alignment between user intent and agent action is explicit and verifiable — every Action traces back to an Intent through Decisions and Reasoning.
  - Both humans and AI agents can be Principals with the same affordances.

stakeholders:
  - principal_01KR441EA199MZCP7RDMADFZW9   # torrenegra
  - principal_01KR441EA259F7EE420Z4VWFPJ   # claude-opus-4-7

applies_to:
  any_of:
    - tag: scope_meta

created_at: 2026-05-08T15:18:00Z
created_by: principal_01KR441EA199MZCP7RDMADFZW9
revision: 1
lifecycle: active
status: active
tags:
  - tag_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# Build an alignment framework

Reduce misalignment between users and AI agents, and between collaborating
agents, by making **intent**, **rules**, **decisions**, **reasoning**, and
**actions** explicit, queryable, and verifiable — before, during, and after
execution.

The alignment graph is the path `Intent → Reasoning → (Decision →) Action`,
with `Rule` overlaid as the boundary and runtime check (SCHEMA.md §6).

This intent is the parent of every other intent in the Evalo project —
runtime-checking, self-hosting, dual-user-model, and agent-comprehension-first
all serve it.
