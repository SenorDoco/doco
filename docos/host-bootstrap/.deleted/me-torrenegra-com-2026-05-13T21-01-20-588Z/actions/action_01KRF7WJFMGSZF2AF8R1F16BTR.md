---
id: action_01KRF7WJFMGSZF2AF8R1F16BTR
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: Admin edits a thought in place on `/post.html?id=<id>` — same page the
  reader uses, with an inline Edit toolbar that only shows when the password
  verifies.
actor_id: principal_01KREVW1FB0H73HQN9C4J0H8JX
verb: edit_thought_inline
intent_ids:
  - intent_01KRF7X9ZABX9NMC2SJK304BK9
follows:
  - action_01KRF7WJFJDH4QDAZN2SNQXC5K
inputs:
  conceptual_actor: Alex (site owner).
  reveal_gate:
    - On `/post.html` boot, post.js fetches `/posts.json`, finds the post by
      `?id=`, renders it (reader path), then calls `verifyPassword()`. Only if
      the password verifies does it reveal `#admin-toolbar` (post.js:240-242,
      post.html:31).
  enter_edit:
    - "Click Edit → `enterEditMode()` (post.js:132-147): initialize the two
      `ThoughtEditor` instances, pre-fill date / EN content / ES content / media
      blocks from `currentPost`, hide the reader article + toolbar, show the
      editor section, scroll to top."
  form_fields:
    - "Same fields as `publish_new_thought`: date, EN content textarea, EN media
      blocks, ES content textarea, ES media blocks."
    - Pre-populated from `currentPost` using `contentFromBlocks` (paragraphs →
      markdown) and `mediaFromBlocks` (rest) (post.js:86-95).
  validation_local:
    - "Same checks as new: date required, media-block validation, both languages
      must end up non-empty."
outputs:
  request:
    - "PUT `/api/post` with body `{ id: currentPost.id, date, blocks_en,
      blocks_es }` (post.js:178-182). Note: `id` IS sent for PUT (vs. POST in
      the publish flow)."
  on_success:
    - 'Status: "Saved. Vercel will redeploy in ~30 seconds." (post.js:188).'
    - "`currentPost` updated in memory; `renderPost(currentPost)` re-renders the
      reader view inline; `exitEditMode()` flips back to the reader view
      (post.js:189-191, :149-154)."
  on_failure:
    - 'Status: "Save failed: <error>". Stay in edit mode; admin can fix and
      retry.'
  cancel_path:
    - "Cancel button → `exitEditMode()` (post.js:149-154): hide editor, restore
      reader article + toolbar. No network call, no save."
constraints_observed:
  - Editor lives in the *same* document as the reader view — toggling between
    modes is a `hidden` flip, not a navigation. Preserves scroll context after
    save.
  - Same `ThoughtEditor` and `PostBlocks` components are used for both new and
    edit. Composition rules stay consistent across the two surfaces.
  - Save button is disabled while uploads run (mirrors the new-thought flow's
    invariant).
  - ES toggle is auto-hidden in the lang toggle if the post lacks an ES body
    (post.js:230-234) — but the edit form still shows both languages so the
    admin can fill the missing one.
created_at: 2026-05-12T23:13:03Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: active
scopes:
  - scope_01KRF57XG0YD45SHA8FM8EDZPB
---

# Step 3b — Edit a thought inline

Code: `post.html` (editor markup inside the same document) + `post.js` + `editor.js`.

The detail page does double duty. For an anonymous reader it's read-only. For the admin (after `verifyPassword()` succeeds), an Edit/Delete toolbar appears below the article. Clicking Edit doesn't navigate — it flips the same document into edit mode by toggling `hidden` flags, pre-fills the editor from `currentPost`, and lets the admin save with PUT `/api/post`.

The shared-page-shared-component approach keeps the edit experience identical to publish (same `ThoughtEditor`, same validation rules) and avoids a second route to maintain. The only meaningful API difference is method (PUT vs POST) and the presence of an `id` in the body.
