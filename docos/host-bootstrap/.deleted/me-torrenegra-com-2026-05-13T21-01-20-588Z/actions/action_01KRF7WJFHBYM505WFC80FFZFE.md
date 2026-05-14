---
id: action_01KRF7WJFHBYM505WFC80FFZFE
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: Admin unlocks `/admin.html` with the shared password; password is held
  in `sessionStorage.admin_pw` for the tab and sent on every request as
  `X-Admin-Password`.
actor_id: principal_01KREVW1FB0H73HQN9C4J0H8JX
verb: admin_sign_in
intent_ids:
  - intent_01KRF7X9ZABX9NMC2SJK304BK9
inputs:
  conceptual_actor: Alex (site owner).
  landing:
    - Visit `/admin.html` (admin.html sets `<meta name="robots"
      content="noindex, nofollow">` — the page is not indexed).
  client_state:
    - On load, admin.js reads `sessionStorage['admin_pw']`. If present, POSTs to
      `/api/verify` with the password in `X-Admin-Password`. If 2xx, skip the
      lock and reveal the editor immediately.
  manual_path:
    - Lock panel (`#lock`) shows; admin enters password in the password input
      and clicks Unlock.
    - "Client POSTs `/api/verify` with `Content-Type: application/json` +
      `X-Admin-Password: <password>`."
outputs:
  on_success:
    - Password saved to `sessionStorage['admin_pw']`.
    - Lock panel hidden, editor panel (`#editor`) revealed.
    - "`loadThoughts()` runs: GET `/posts.json?t=<Date.now()>` with `cache:
      'no-store'`, sort by `date desc`, render the thought-list (admin.js:54-66,
      :83-122)."
  on_failure:
    - Password cleared from memory + sessionStorage.
    - 'Status text: "Incorrect password." with `.err` class (admin.js:41-44).'
  on_signout:
    - "Sign-out button: clear password, clear sessionStorage, re-lock UI
      (admin.js:48-52)."
constraints_observed:
  - Single shared password; no per-user accounts. Sized for a one-person admin
    surface.
  - Password lives in `sessionStorage`, not `localStorage` — closing the tab
    signs out.
  - "`X-Admin-Password` is sent on every authenticated call (verify, post, put,
    delete). No bearer token, no cookie."
  - "`noindex, nofollow` on admin.html and new.html to keep the admin surface
    out of search results."
created_at: 2026-05-12T23:13:00Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: active
scopes:
  - scope_01KRF57XG0YD45SHA8FM8EDZPB
---

# Step 1 — Admin signs in

Code: `admin.html` (lock panel + editor markup) + `admin.js`.

The page renders the lock by default. On boot, `admin.js` checks `sessionStorage['admin_pw']`; if there's a stored password and `/api/verify` confirms it, the lock is skipped and the thought list loads immediately. Otherwise the admin enters the password manually.

The same `X-Admin-Password` header authenticates every subsequent request in the flow — there's no cookie or bearer token. That's why the per-tab `sessionStorage` choice matters: closing the tab forgets the password without needing an explicit sign-out.
