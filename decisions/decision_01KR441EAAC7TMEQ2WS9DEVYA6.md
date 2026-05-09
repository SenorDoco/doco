---
id: decision_01KR441EAAC7TMEQ2WS9DEVYA6
evalo_id: evalo_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "Web UI theme is light by default; the only typeface is Ubuntu Mono — both prose and code surfaces use the same monospace family."

slug: ui-theme-light-and-ubuntu-mono
number: "ADR-056"
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "What visual theme does the web UI use, and what typeface(s)?"
chosen: |
  Light theme as the default — near-white background (oklch ~0.99), dark
  blue-tinted foreground (oklch ~0.20 248), light-gray borders. Tokens
  defined in @theme inside app/app.css using oklch.

  Single typeface: Ubuntu Mono (loaded from Google Fonts) for ALL text —
  prose, headings, code, table cells, badges. Both --font-sans and
  --font-mono point at "Ubuntu Mono".
alternatives:
  - name: Dark theme (the initial Phase-5 default)
    rejected_because: "Founder requested light. Dark stays as a future toggle (system preference detection deferred)."
  - name: Sans-serif (Inter / system stack) for prose, monospace for code only
    rejected_because: "Founder requested 'monospace Ubuntu' for everything. The unified-monospace look reinforces the 'code editor for alignment data' aesthetic."
rules_consulted: []
decided_by: principal_01KR441EA199MZCP7RDMADFZW9
decided_at: 2026-05-08T17:30:00Z

created_at: 2026-05-08T17:30:00Z
created_by: principal_01KR441EA259F7EE420Z4VWFPJ
revision: 1
lifecycle: active
status: accepted
tags:
  - tag_01KR441EA37E3M5V0ZV6ZRB97D
  - tag_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-056 — UI theme = light, type = Ubuntu Mono everywhere

Verified live in Chrome via getComputedStyle on document.body — fontFamily
resolves to "Ubuntu Mono", color is oklch(0.20 0.015 248), background is
oklch(0.99 0.002 240).

Future: system-preference-aware dark/light toggle (defer until enough users
ask).
