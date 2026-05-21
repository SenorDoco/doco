---
id: action_01KRF7WJFN5D60FCKQB8D2MV3K
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: Admin deletes a thought — from the admin list (stay on page, remove the
  row) or from the post detail (redirect to home). Always preceded by a
  `confirm()` dialog.
actor_id: principal_01KREVW1FB0H73HQN9C4J0H8JX
verb: delete_thought
intent_ids:
  - intent_01KRF7X9ZABX9NMC2SJK304BK9
follows:
  - action_01KRF7WJFJDH4QDAZN2SNQXC5K
inputs:
  conceptual_actor: Alex (site owner).
  trigger_paths:
    - "From `/admin.html`: row-level Delete button (admin.js:112-116). Calls
      `deleteThought(post.id)`."
    - "From `/post.html`: Delete button on the admin toolbar (post.js:194-207).
      Calls `deleteCurrent()`."
  confirmation:
    - Both paths gate the action behind `confirm("Delete thought '<id>'? This
      cannot be undone.")` (admin.js:130, post.js:196).
outputs:
  request:
    - "DELETE `/api/post?id=<encodeURIComponent(id)>` with `X-Admin-Password:
      <password>` header (admin.js:132-135, post.js:197-200)."
  on_success_from_admin:
    - 'Status: "Deleted. Vercel will redeploy in ~30 seconds." (admin.js:141).'
    - Local `thoughts` array filtered to remove the deleted id;
      `renderList(thoughts)` re-renders without it (admin.js:142-143).
  on_success_from_post:
    - Navigate to `/` (post.js:206) — the post page no longer makes sense for a
      deleted thought.
  on_failure:
    - "From admin: status with `.err` class showing the error code
      (admin.js:136-139)."
    - "From post: `alert()` with the error code (post.js:201-204). No state
      change; the page stays on the now-undeleted thought."
  side_effects:
    - Server removes the post from `posts.json` in the repo + pushes to `main`.
    - Vercel auto-redeploys; thought disappears from production in ~30 seconds.
constraints_observed:
  - Native `confirm()` dialog (not a custom modal) — the admin is one person,
    the confirmation only needs to be unmissable, not pretty.
  - Hard delete, no soft-delete / trash / restore. The repo's git history is the
    recovery path if a delete was unintentional.
  - Two callers, one server endpoint — same DELETE request shape regardless of
    trigger surface.
created_at: 2026-05-12T23:13:04Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: active
---

# Step 3c — Delete a thought

Code: `admin.js` (`deleteThought`, line 129) + `post.js` (`deleteCurrent`, line 194).

The two surfaces (admin list and post detail) both go through the same DELETE `/api/post?id=<id>` endpoint with the same password header. The only difference is the success path:

- From the admin list, the deleted row is filtered out client-side and the page stays put — the admin can keep working through the list.
- From the post detail, there's no useful in-place state to fall back to, so the page navigates to `/`.

Hard delete by design. Recovery is git, not a trash bin.
