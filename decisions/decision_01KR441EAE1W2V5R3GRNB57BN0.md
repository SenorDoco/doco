---
id: decision_01KR441EAE1W2V5R3GRNB57BN0
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "gray-matter's frontmatter parser is wired to the spec-compliant `yaml` 2.x package instead of its bundled js-yaml 3.x."

slug: yaml-2x-as-frontmatter-engine
number: "ADR-060"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2   # agent-comprehension-first
question: "Which YAML parser parses entity-file frontmatter?"
chosen: |
  Configure gray-matter with `engines: { yaml: { parse: yaml.parse, stringify: yaml.stringify } }`
  using the `yaml` package (v2.x). Discovered during Phase 1 that gray-matter's
  bundled js-yaml 3.x rejects some valid edge cases (e.g., colon-space inside
  backticks in unquoted list items) AND that yaml 2.x is stricter about leading
  reserved characters — the two parsers fail on different inputs. yaml 2.x is
  YAML-1.2-spec-compliant; using a single parser everywhere keeps the data
  portable to any spec-compliant tool.

  As a corollary, frontmatter authors must quote list items that start with
  reserved characters (backtick, etc.) or contain `: ` outside of identifier-key
  position. A repair script (`/tmp/fix_yaml_v3.mjs`) was used during Phase 1 to
  audit and fix existing entity files; the convention is now enforced by the
  schema validator + lint pass.
alternatives:
  - name: Stay with gray-matter's bundled js-yaml 3.x
    rejected_because: "Permissive in different ways than yaml 2.x; data that parses with one but not the other is portability-fragile."
  - name: Hand-write a tolerant YAML parser
    rejected_because: "Out of scope; reinvents a hard problem badly."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-08T16:00:00Z

created_at: 2026-05-08T16:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-060 — Frontmatter engine = yaml 2.x

Lives in [@doco/core files.ts](../packages/core/src/files.ts) as the
`matterOptions.engines.yaml` block.
