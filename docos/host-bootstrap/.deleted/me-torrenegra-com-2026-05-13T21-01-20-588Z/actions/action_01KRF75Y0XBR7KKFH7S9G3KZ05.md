---
id: action_01KRF75Y0XBR7KKFH7S9G3KZ05
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: Reader picks a card from the feed and navigates to its full detail page
  at `/post.html?id=<id>`.
actor_id: principal_01KRF55AR9H0RDQREGYH7WQWMQ
verb: open_thought
intent_ids:
  - intent_01KRF74MYH1103XKFA3D26YWXX
follows:
  - action_01KRF75Y0WAVP5YR1CRCSWTV53
inputs:
  conceptual_actor: anonymous site visitor.
  trigger:
    - Click anywhere on a `.post-card` element rendered by step 1.
  click_filter:
    - Skip navigation if `e.target.closest('a, iframe, button, input,
      textarea')` matches — lets readers play an embedded YouTube/Vimeo, click
      an inline link, or interact with embedded media without being yanked away.
    - Skip navigation if `window.getSelection()` returns a non-empty string —
      preserves text-selection-for-copy.
  read_state:
    - "`post.id` from the card's data (the rendered card's link target is
      `post.html?id=<encodeURIComponent(post.id)>`, app.js:25)."
outputs:
  navigation:
    - "`window.location.href = 'post.html?id=' +
      encodeURIComponent(post.id)`  (app.js:51)."
  preserved_state:
    - Language selection survives — it's read from `localStorage` again on the
      destination page.
    - Page-number context is lost (no back-button breadcrumb). Browser back
      returns to the feed at the previous `?page=` value via normal history.
constraints_observed:
  - Click handler is on the `<li>` wrapper, but the visible date link inside it
    also points to the same URL — so keyboard users tabbing to the link get a
    normal `<a>` activation, while pointer users hit the wider click target.
  - URL encoding via `encodeURIComponent` — post ids may contain characters that
    need escaping.
created_at: 2026-05-12T23:08:01Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: active
scopes:
  - scope_01KRF57XG0YD45SHA8FM8EDZPB
---

# Step 2 — Open a thought

Code: `app.js` lines 21-55 (card render + click handler).

The card is a generously-sized click target: the whole `<li class="post-card">` listens for `click` and routes to the post detail page. The handler is careful about two cases:

- **Inline interactivity.** Embedded YouTube/Vimeo players, inline `<a>` links, and form-like controls (`input`, `textarea`, `button`) get a clean pass — clicking them does *not* trigger navigation. Implemented with `e.target.closest('a, iframe, button, input, textarea')`.
- **Text selection.** If the reader has any selection active (`window.getSelection().toString()`), the click is interpreted as "finish selecting," not "navigate."

The card also renders a visible `<a>` around the date so the click target is reachable by keyboard.
