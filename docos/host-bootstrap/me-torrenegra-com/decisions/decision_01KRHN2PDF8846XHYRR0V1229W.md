---
id: decision_01KRHN2PDF8846XHYRR0V1229W
doco_id: doco_01KRHJQC0YMK6VEPZSMCQVP1QD
node_type: decision
summary: No local dev — verify only on hosted previews
question: How do agents test and verify changes to me.torrenegra.com?
chosen: "Never run, build, or serve the site locally. No python3 -m http.server,
  no file://, no local install. All verification happens online (Vercel preview,
  prod, or another hosted environment). Reason: the site embeds Vercel/CDN
  behavior; local runs can mislead."
decided_by: principal_01KRHJQCG3HH5AYBZWEZHCS9MY
decided_at: 2026-05-13T21:49:54.480Z
created_at: 2026-05-13T21:49:54.480Z
created_by: principal_01KRHJQCG3HH5AYBZWEZHCS9MY
lifecycle: active
scopes:
  - scope_01KRHMNFV0WZZ5A2HYZG6K53F9
auto_edges:
  - to_id: scope_01KRHMNYX8TKMXJJVNW8FE3TGV
    edge_type: relates_to
    reason: The decision to verify only on hosted previews is related to user flows,
      as it impacts how users interact with the feature during their journeys.
  - to_id: scope_01KRHJQC102W49PXAC9QYMDS97
    edge_type: supports
    reason: The constitution provides the foundational rules and claims that support
      the decision to limit verification to hosted previews.
---
