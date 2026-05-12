---
id: decision_01KR441EAMKYKCEBSEYHGJ8M3Z
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Strict priority order: agent comprehension > agent updates > human comprehension > scoping > version control > performance > issue detection."

slug: optimization-priority-order
number: "ADR-001"
intent_ids:
  - intent_01KR441EAD70XGG1TS53WT8JM2   # agent-comprehension-first
  - intent_01KR441EA92V53H22ZN087YMRM   # alignment-framework
question: "How do we resolve design tradeoffs when two priorities conflict?"
chosen: |
  AI agent comprehension > AI agent updates > Human comprehension > Scoping >
  Version control > Performance > Automated issue identification. When two
  pressures conflict, the higher priority wins. Crucially, agent comprehension
  is above human comprehension — when the two diverge, schema choices favor
  what is parseable by agents.
alternatives:
  - name: Equal-weight priorities
    rejected_because: "Lets every tradeoff be relitigated; the schema/api/UX drift over time."
  - name: Performance first
    rejected_because: "Optimizes for the wrong audience — Doco's whole point is alignment surface area, not speed."
  - name: Human-comprehension first
    rejected_because: "Conventional but wrong for Doco. Agents are first-class users (intent_01KR441EACJYB895DWKG7Z25SF); their comprehension determines whether the framework can be operated at all."
rules_consulted: []
decided_by: torrenegra
decided_at: 2026-05-08T15:18:00Z

created_at: 2026-05-08T15:18:00Z
created_by: torrenegra
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D   # tag_adr
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# ADR-001 — Optimization priority order (strict)

Drives every other tradeoff. Operationalized as
[rule_01KR441EAF7M5QPF65BXGD1ET1](../rules/rule_01KR441EAF7M5QPF65BXGD1ET1.md).

Reference: SCHEMA.md §1.
