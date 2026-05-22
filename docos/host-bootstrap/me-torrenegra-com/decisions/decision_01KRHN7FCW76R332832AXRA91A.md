---
id: decision_01KRHN7FCW76R332832AXRA91A
doco_id: doco_01KRHJQC0YMK6VEPZSMCQVP1QD
entity_type: decision
summary: Posts stored as JSON with block-based schema
question: How are blog posts modeled and rendered?
chosen: All posts live in posts.json as a single JSON file. Each post is
  composed of typed blocks defined in blocks.js. Renderers (post.js, index.html,
  post.html) consume the block list. The admin editor (admin.html + editor.js +
  new.js) writes posts.json. Any change to block types, post fields, or the
  editor↔renderer contract should be captured here.
decided_by: principal_01KRHJQCG3HH5AYBZWEZHCS9MY
decided_at: 2026-05-13T21:52:31.132Z
created_at: 2026-05-13T21:52:31.132Z
created_by: principal_01KRHJQCG3HH5AYBZWEZHCS9MY
lifecycle: active
auto_synapses:
  - to_id: decision_01KRHMZE5444PVATY5B3KYJBPM
    synapse_type: supersedes
    reason: The decision to adopt Doco for project documentation replaces the
      previous documentation method, which is relevant to the JSON block-based
      schema.
---
