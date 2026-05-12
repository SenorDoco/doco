---
id: idea_01KR6QZCHKRJH1YH2V6EXQ7S9H
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: idea
schema_version: "0.1"
summary: "Document ideas. Capture speculative thoughts before they crystallize into intents, decisions, or actions."

proposer_id: torrenegra   # torrenegra
body: |
  We needed a place to put half-formed thoughts — "what if we did X?" —
  that aren't yet wants (Intent), choices (Decision), or tasks (Action).
  This idea proposed adding `idea` as the 12th node type. It was promoted
  in the same turn it was proposed, becoming ADR-074 + the implementing
  Action.

promoted_to: decision_01KR6QZCH0RSDB22YC5H6M4BKZ   # ADR-074

created_at: 2026-05-09T16:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: succeeded
status: promoted
scopes:
  - scope_01KR441EA8BTTB99H928Z0NQQW   # scope_meta
---

# The very first idea — "Document ideas"

Filed as the first entity in the new `ideas/` directory, eating its own
dog food: this idea, once captured, was promoted to an actual decision
(ADR-074) and an action that ships the schema/code/UI changes.

The pattern this models for future ideas:

1. Someone has a thought ("we should do X").
2. Open an `idea_<ULID>.md` with `lifecycle: proposed`. Just `summary`
   + `body` + `proposer_id` is enough.
3. When the idea matures into a real plan, promote:
   - Pick the right downstream type (Intent, Decision, Action).
   - Set `lifecycle: succeeded` and `promoted_to: <new-id>` on the idea.
4. If the idea is rejected, set `lifecycle: abandoned` +
   `rejection_reason`.
5. Long-stale ideas can live indefinitely. They cost nothing.
