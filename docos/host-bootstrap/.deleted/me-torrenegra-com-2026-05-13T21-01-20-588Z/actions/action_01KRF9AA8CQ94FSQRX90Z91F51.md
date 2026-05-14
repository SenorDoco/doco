---
id: action_01KRF9AA8CQ94FSQRX90Z91F51
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: "Bug report: admin Edit/Delete toolbar visible to anonymous readers on
  `/post.html` — `.admin-buttons { display: flex }` overrode the `[hidden]`
  attribute, so buttons painted regardless of the JS auth gate."
actor_id: principal_01KREVW1FB0H73HQN9C4J0H8JX
verb: report_bug
intent_ids:
  - intent_01KRF7X9ZABX9NMC2SJK304BK9
  - intent_01KRF74MYH1103XKFA3D26YWXX
inputs:
  conceptual_actor: Alex (site owner) — noticed the leak on the live site.
  symptom:
    - Open any thought page (`/post.html?id=<id>`) without signing in as admin.
    - Edit and Delete buttons render below the article, even though `<section
      id='admin-toolbar' class='admin-buttons' hidden>` is in the markup.
    - Same issue would affect any element that uses `[hidden]` AND has a class
      with an explicit `display:` rule (`.admin-editor`, `.admin-lock`, etc.) —
      wider than just the toolbar.
  observed_on:
    - Production (me.torrenegra.com) and any local preview.
    - All five HTML pages that load `styles.css` (admin.html, bio-pics.html,
      index.html, new.html, post.html).
  severity:
    - Visual leakage of admin UI to anonymous readers — could be mistaken for an
      attack surface, but the API still gates on `X-Admin-Password`, so no
      actual privilege escalation.
    - "Medium: confusing, looks broken, suggests the site has bugs — but not
      exploitable."
  reproduce:
    - 1. In an incognito window, open any thought detail page on
      me.torrenegra.com.
    - 2. See Edit and Delete buttons below the article.
    - "3. Inspect: `#admin-toolbar` has the `hidden` attribute but computes
      `display: flex`."
outputs:
  triage:
    - "Root cause: CSS specificity. The user-agent stylesheet's `[hidden] {
      display: none }` rule is overridden by a more specific class selector with
      `display: flex`. The HTML spec says `hidden` should hide, but it loses the
      cascade."
    - "Surface: any class with explicit `display:` on an element that may carry
      `hidden`. The admin toolbar is the visible offender; the editor section +
      lock section have the same shape."
    - "Routes to fix: (a) force `[hidden]` to win globally via `!important`, (b)
      hide the admin section with JS instead of `hidden`, (c) per-element CSS
      overrides."
constraints_observed:
  - Static site, no build step — the fix needs to land in `styles.css` directly.
  - Cache-buster `?v=N` on the stylesheet link must be bumped or the fix won't
    reach returning visitors.
  - Whatever the fix is, must apply universally (every page that loads
    styles.css), not just `/post.html`.
started_at: 2026-04-29T00:00:00Z
ended_at: 2026-04-29T23:45:37Z
created_at: 2026-04-29T23:45:37Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: succeeded
scopes:
  - scope_01KRF7VQ4BXA38JM5DPJ2N67SS
---

# Bug — admin toolbar visible to anonymous readers

**Reported:** ~2026-04-29 (date of fix commit `d5a9206`).
**Reporter:** Alex (site owner).
**Severity:** medium — visual leak, not exploitable.

## What you see

On any thought page, opened anonymously (no admin session), the Edit and Delete buttons appear below the article. They shouldn't — they belong to the admin flow and the HTML marks them as `hidden`.

## Why it happens

`post.html` line 31:

```html
<section id="admin-toolbar" class="admin-buttons" hidden style="margin-top:1rem;">
  <button id="edit-btn" class="admin-btn" type="button">Edit</button>
  <button id="delete-btn" class="admin-btn danger" type="button">Delete</button>
</section>
```

`styles.css`:

```css
.admin-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
```

The browser's user-agent stylesheet has `[hidden] { display: none }` — but it's a generic attribute selector. The author stylesheet's class selector `.admin-buttons { display: flex }` is more specific *and* later in the cascade, so `display: flex` wins. The `hidden` attribute looks like it does nothing.

The same shape exists for `.admin-editor` and `.admin-lock` — anywhere an author rule sets `display` on an element that also carries `hidden`.

## Where it hurts

Visual leak of admin UI to anyone reading a thought page. The API still requires `X-Admin-Password`, so clicking Edit or Delete won't actually do anything destructive — but it looks broken and signals to readers that the site has weak gating.

## What the fix has to do

Make `[hidden]` win against any class-set `display:` rule, universally, on every page that loads `styles.css`. See the linked Decision for the chosen fix.
