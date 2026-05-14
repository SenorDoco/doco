---
id: decision_01KRF9CJF4DWXMQQNAWXGYDQQJ
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: decision
summary: "Add one global rule to `styles.css`: `[hidden] { display: none
  !important; }`."
intent_ids:
  - intent_01KRF7X9ZABX9NMC2SJK304BK9
question: "How do we stop the admin Edit/Delete toolbar from painting on
  `/post.html` for anonymous readers, given that the `hidden` attribute loses to
  `.admin-buttons { display: flex }` in the cascade?"
chosen: 'Add one global rule to `styles.css`: `[hidden] { display: none
  !important; }`. This forces the HTML `hidden` attribute to win against any
  class-set `display:` rule, on any element, on every page that loads the
  stylesheet. Bump the `?v=` cache-buster on the `<link rel="stylesheet">` tag
  in every HTML file so returning visitors pick up the new rule on next paint.'
alternatives:
  - name: Hide the admin section with JavaScript at boot (set `style.display = none`
      before paint)
    rejected_because: Still allows a flash-of-admin-UI between paint and JS init,
      and depends on JS running successfully. A CSS-level fix is paint-clean and
      works even if scripts fail.
  - name: "Rename `.admin-buttons` on `#admin-toolbar` specifically so it doesn't
      inherit `display: flex`"
    rejected_because: Doesn't generalize. The same `[hidden]` + class-with-`display`
      bug could (and does) affect `.admin-editor` and `.admin-lock` too. A
      targeted rename treats one symptom, not the class of bug.
  - name: "Replace `[hidden]` usage with a custom attribute or class (e.g.
      `.is-hidden { display: none }`)"
    rejected_because: Deviates from the web standard `hidden` attribute. Future
      contributors and assistive tech expect `hidden` to mean what it says —
      keeping that contract intact is worth one CSS line.
  - name: "Set `display: none` directly on `#admin-toolbar` and toggle it via JS
      instead of using `hidden`"
    rejected_because: Same JS-dependence + per-element cost as the JS option.
      Doesn't fix the underlying cascade issue for other `[hidden]` users on the
      site.
decided_by: principal_01KREVW1FB0H73HQN9C4J0H8JX
decided_at: 2026-05-12T23:47:06.341Z
created_at: 2026-05-12T23:47:06.341Z
created_by: principal_01KREVW1FB0H73HQN9C4J0H8JX
lifecycle: active
scopes:
  - scope_01KRF7VQ4BXA38JM5DPJ2N67SS
---

## Why this fix is correct

The HTML spec treats `hidden` as equivalent to `display: none`, but only via the user-agent stylesheet — which loses to any author stylesheet rule. Adding `[hidden] { display: none !important; }` to the author stylesheet makes the contract intact: an element marked `hidden` is hidden, regardless of what classes it carries.

`!important` is the right tool here because the rule is meant to be a backstop. The intent is that `hidden` is non-negotiable — you don't override it from a class.

## Scope of the fix

Applies to every page that loads `styles.css`:

- `index.html`
- `post.html`
- `admin.html`
- `new.html`
- `bio-pics.html`

Cache-buster `?v=7` → `?v=8` on each link tag (the fix commit `d5a9206` bumped to `?v=8`; subsequent CSS edits have advanced to `?v=9`).

## Verification

In an incognito window, open `/post.html?id=<any-id>`. The Edit/Delete toolbar must not be in the DOM-visible tree (computed style `display: none`). Inspect: `#admin-toolbar` should report `display: none` in DevTools' Computed pane.

## Related

- Report Action: `action_01KRF9AA8CQ94FSQRX90Z91F51` (verb: `report_bug`).
- Fix Action: linked from this Decision's `id` once the fix Action is captured (verb: `apply_fix`, ref commit `d5a9206`).
- A regression guard Rule could be added later (`scope_regression_guard`) that forbids using a class with an explicit `display:` on elements that also carry the `hidden` attribute — but this static site has no test harness, so the regression test would have to be a lint or manual checklist.
