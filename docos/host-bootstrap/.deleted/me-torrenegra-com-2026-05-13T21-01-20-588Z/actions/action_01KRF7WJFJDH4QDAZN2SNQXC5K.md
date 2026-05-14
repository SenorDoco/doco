---
id: action_01KRF7WJFJDH4QDAZN2SNQXC5K
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: "Admin sees the list of existing thoughts and picks one of three
  branches: publish a new one, open an existing one, or delete an existing one."
actor_id: principal_01KREVW1FB0H73HQN9C4J0H8JX
verb: admin_pick_action
intent_ids:
  - intent_01KRF7X9ZABX9NMC2SJK304BK9
follows:
  - action_01KRF7WJFHBYM505WFC80FFZFE
inputs:
  conceptual_actor: Alex (site owner), already signed in (Step 1).
  data:
    - "`/posts.json?t=<Date.now()>` fetched fresh, sorted by `post.date` desc
      (admin.js:54-66)."
    - Each row renders `post.date` + a 50-char summary derived from the EN
      paragraph blocks (fallback to ES, then `post.blocks`); falls through to
      `post.id` if all paragraph fields are empty (admin.js:68-81).
outputs:
  branches:
    - "**+ New thought** (top button) → navigate to `/new.html` (admin.html:36).
      Continues at the `publish_new_thought` Action."
    - "**Open** (per-row) → navigate to
      `/post.html?id=<encodeURIComponent(post.id)>` (admin.js:108-111). The post
      page detects the auth and shows the inline admin toolbar; continues at the
      `edit_thought_inline` Action."
    - "**Delete** (per-row) → confirm dialog, then DELETE the thought in-place.
      Continues at the `delete_thought` Action."
  empty_state:
    - 'If `/posts.json` returns an empty array: list shows "No thoughts yet."
      (admin.js:85-90).'
  error_state:
    - "If `/posts.json` fetch fails: list shows \"Couldn't load thoughts.\"
      (admin.js:63-65)."
constraints_observed:
  - List is read fresh on every editor reveal (no caching) — a recent change is
    visible without a page reload.
  - Sort order matches the reader feed (date desc, with the row's date as the
    primary display).
  - There is no inline search or filter — list is short enough that scanning is
    the assumed pattern.
created_at: 2026-05-12T23:13:01Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: active
scopes:
  - scope_01KRF57XG0YD45SHA8FM8EDZPB
---

# Step 2 — Pick a branch

Code: `admin.html` (list markup) + `admin.js` (load + render).

After unlocking, the admin sees one screen with three possible next moves:

- **+ New thought** at the top — takes them to `/new.html`.
- A per-row **Open** link — takes them to `/post.html?id=<id>` where the same page the reader uses also exposes an Edit/Delete toolbar because the password verifies.
- A per-row **Delete** button — confirms, then issues `DELETE /api/post?id=<id>` directly from this page.

The summary on each row is derived from the EN paragraph blocks (or ES if EN is empty), markdown-stripped, capped at 50 chars. Useful when post IDs aren't human-meaningful.
