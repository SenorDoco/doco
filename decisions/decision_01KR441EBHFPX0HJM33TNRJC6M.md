---
id: decision_01KR441EBHFPX0HJM33TNRJC6M
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Rule discovery uses 5 retrieval strategies: structural match, tag overlap, reference-graph expansion, semantic embedding search, glossary expansion."

slug: five-strategy-rule-discovery
number: "ADR-030"
intent_ids:
  - intent_01KR441EAA9Y78V8DEKYDB4CWP
question: "How does an agent find the Rules relevant to its task when its vocabulary differs from the Rule authors'?"
chosen: |
  Combine five retrieval strategies:
    1. **Structural match** — `scope_match` index hits (precision-tight).
    2. **Tag overlap** — Rules tagged with any tag carried by the work item.
    3. **Reference-graph expansion** — Rules attached to neighbors of the target.
    4. **Semantic search** — vector embedding NN over Rule summary + body.
    5. **Glossary expansion** — keywords expanded through `glossary.yaml`.

  Strategies 1-3 are precision-tight (block on `must` violations); 4-5 are
  advisory (low false-negative tolerance, surface as suggestions).
alternatives:
  - name: Pure keyword search
    rejected_because: "Misses vocabulary mismatch — the agent says 'validate emails' while the Rule says 'input sanitization'."
  - name: Pure semantic search
    rejected_because: "Generates false positives that block precise runtime checks."
rules_consulted: []
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

# ADR-030 — Five-strategy retrieval

Reference: SCHEMA.md §10.1.
