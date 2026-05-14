---
id: action_01KRF9AA8DXE3X3EWPN57TCS5S
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: "Fix applied (commit `d5a9206`): added `[hidden] { display: none
  !important; }` to `styles.css` and bumped the cache-buster on every page's
  stylesheet link from `?v=7` to `?v=8`."
actor_id: principal_01KRF55AR9H0RDQREGYH7WQWMQ
verb: apply_fix
decision_ids:
  - decision_01KRF9CJF4DWXMQQNAWXGYDQQJ
follows:
  - action_01KRF9AA8CQ94FSQRX90Z91F51
  - decision_01KRF9CJF4DWXMQQNAWXGYDQQJ
inputs:
  conceptual_actor: Claude (previous session) implementing under Alex's direction.
  source:
    - "Commit: d5a9206802a87c3975a2486ef07c4e3915f57bb7"
    - "Date: 2026-04-29 (per `git log`)."
    - "Author: Claude <noreply@anthropic.com> (a previous agent session, before
      this Doco existed)."
outputs:
  files_changed:
    - "styles.css — added `[hidden] { display: none !important; }` at line 14."
    - admin.html — `styles.css?v=7` → `?v=8`.
    - bio-pics.html — `styles.css?v=7` → `?v=8`.
    - index.html — `styles.css?v=7` → `?v=8`.
    - new.html — `styles.css?v=7` → `?v=8`.
    - post.html — `styles.css?v=7` → `?v=8`.
  diff_stat:
    - 6 files changed, 6 insertions(+), 5 deletions(-).
  verification:
    - "Anonymous incognito on `/post.html?id=<id>` no longer shows Edit /
      Delete; `#admin-toolbar` computes `display: none`."
    - Admin sign-in still flips the toolbar visible (post.js sets
      `toolbar.hidden = false` after `verifyPassword()` succeeds) — the
      `!important` rule only forces `[hidden]` to win when the attribute is
      present.
constraints_observed:
  - The cache-buster bump is part of the fix, not optional — without it,
    returning visitors keep serving the old `styles.css` and the leak persists
    on their machines.
  - The fix is paint-clean (CSS-only). No JS dependency.
  - "Two paint-time invariants are now enforced together: `[hidden]` always
    hides, AND classes with explicit `display:` still work when `hidden` is
    absent."
started_at: 2026-04-29T23:00:00Z
ended_at: 2026-04-29T23:45:37Z
created_at: 2026-04-29T23:45:37Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: succeeded
scopes:
  - scope_01KRF7VQ4BXA38JM5DPJ2N67SS
---

# Fix — force `[hidden]` to win against author `display:` rules

Commit: [d5a9206](https://github.com/torrenegra/personal-site/commit/d5a9206).

## What changed

One CSS rule, one cache-buster bump:

```diff
--- a/styles.css
+++ b/styles.css
@@ -11,6 +11,7 @@
 }
 
 * { box-sizing: border-box; }
+[hidden] { display: none !important; }
 
 html { font-size: 14px; ... }
```

And `styles.css?v=7` → `styles.css?v=8` on the stylesheet `<link>` in each of the five HTML pages.

## How it resolves the bug

The user-agent stylesheet's `[hidden] { display: none }` was being overridden by `.admin-buttons { display: flex }` because the class selector has higher specificity. Author stylesheets win against UA defaults; UA defaults don't carry `!important`.

Adding the same `[hidden]` rule to the author stylesheet *with* `!important` makes the attribute non-negotiable: any element carrying `hidden` is hidden, regardless of class. The admin Edit/Delete toolbar stays out of the DOM until `post.js` flips `toolbar.hidden = false` after the password verifies.

## Why this captures retroactively

The fix landed on 2026-04-29; the Doco started on 2026-05-12. This Action node is a retroactive capture so the bug + fix have a place to live in the model going forward. The `attestation` field flags that this isn't a fresh-event recording — it's reconstructed from `git show d5a9206` and the current code state.
