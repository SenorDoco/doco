---
id: action_01KRF75Y0WAVP5YR1CRCSWTV53
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: "Reader lands on `/`, the home feed: bio + CTA hero, then a paginated
  list of thoughts loaded from `posts.json`."
actor_id: principal_01KRF55AR9H0RDQREGYH7WQWMQ
verb: load_home_feed
intent_ids:
  - intent_01KRF74MYH1103XKFA3D26YWXX
inputs:
  conceptual_actor: anonymous site visitor (the `actor_id` above is the bootstrap
    agent placeholder — the schema requires a real principal but this is an
    abstract reader flow, not a real recorded event).
  url_params:
    page: optional `?page=N` (default 1); clamped to `[1, totalPages]` in
      app.js:97-98.
  client_state:
    lang: "`localStorage['lang']` ∈ {en, es}; defaults to en (lang.js:6-9)."
  network:
    - "GET /posts.json?t=<Date.now()>  (cache: 'no-store') — app.js:88"
outputs:
  rendered:
    - "Hero: H1, taglines, bio links, newsletter CTA form
      (action='/api/subscribe', see separate newsletter flow)."
    - "Feed: top 20 posts of the requested page, sorted by `date desc` then `id
      desc` (app.js:91-96), each rendered via `PostBlocks.renderBlocks` in the
      current language."
    - "Per-card: clickable wrapper navigates to `/post.html?id=<id>` unless the
      click target is `a, iframe, button, input, textarea` or text is currently
      selected (app.js:48-52)."
    - 'Language fallback note shown when the post lacks content in the active
      language (app.js:38-45): "(Not yet translated; showing Spanish)" / "(Aún
      no traducido; mostrando en inglés)".'
    - Pagination footer with Older / Newer links + 'Page N of M' (app.js:61-77);
      hidden when totalPages ≤ 1.
    - Language toggle widget in the feed header (en|es buttons; clicking
      re-renders the cached slice via `Lang.onChange`, app.js:108).
  error_state:
    - "On `posts.json` fetch failure: single card 'Couldn't load thoughts.
      Please try again later.' (app.js:104-106)."
constraints_observed:
  - "Cache-busting query string + `cache: 'no-store'` so a freshly published
    thought appears without a hard refresh."
  - Pagination is URL-based (`/?page=N`), not infinite scroll — back/forward and
    shareable links work.
  - Language choice is client-only (localStorage); no server roundtrip; both
    languages ship in `posts.json`.
created_at: 2026-05-12T23:08:00Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: active
---

# Step 1 — Load the home feed

Code: `index.html` + `app.js` + `lang.js` + `blocks.js`.

What the reader sees on `/`:

1. **Hero / bio.** Static HTML — name, taglines, links to Torre.ai / Bunny / Shark Tank YouTube clips, contact emails.
2. **Newsletter CTA.** Subscribe form (`form.cta-form` → `/api/subscribe`). Handled by `newsletter.js`; documented in its own flow.
3. **Feed.** `app.js` fetches `posts.json` with cache-busting + `no-store`, sorts by `date` (and `id` as tiebreaker), paginates 20-per-page, and renders cards.
4. **Language toggle.** Two buttons (`EN` / `ES`) in the feed header; clicking persists to `localStorage.lang` and re-renders the cached slice.
5. **Pagination.** Older / Newer links + 'Page N of M'; the URL drives state (`/?page=2`).

Edge cases worth keeping in the model:

- `posts.json` fetch fails → graceful single-card error message (no crash, no infinite spinner).
- A post is missing the active-language body → render the other language with a small italic note explaining why.
- `?page=` above the total → clamped to the last page (app.js:98) so a stale link never lands on an empty feed.
