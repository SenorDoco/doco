---
id: action_01KRF7WJFKY59ATYB1N38HBB17
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: action
summary: "Admin publishes a new thought from `/new.html`: date + EN + ES content
  + media blocks, validated locally, then POSTed to `/api/post`."
actor_id: principal_01KREVW1FB0H73HQN9C4J0H8JX
verb: publish_new_thought
intent_ids:
  - intent_01KRF7X9ZABX9NMC2SJK304BK9
follows:
  - action_01KRF7WJFJDH4QDAZN2SNQXC5K
inputs:
  conceptual_actor: Alex (site owner).
  guard:
    - On `/new.html` boot, `new.js` calls `verifyPassword()` (POST
      `/api/verify`); on failure, redirects to `/admin.html` (new.js:99-102).
      Direct navigation without a valid session-stored password bounces back.
  form_fields:
    - Date input (`#date`) — defaults to today's ISO date (new.js:29-34);
      required.
    - English content textarea (`#content-en`) — markdown source; converted to
      paragraph blocks via `PostBlocks.paragraphsAndEmbedsFromContent`
      (new.js:36-38, :62-67).
    - Spanish content textarea (`#content-es`) — same conversion.
    - 'Per-language media block lists (EN: image / youtube / vimeo / pdf; ES:
      same four). Each block is added via the `[data-add="<lang>:<type>"]`
      buttons (new.js:55-60).'
  validation_local:
    - Date required.
    - Each language's media list passes `editors[lang].validateMedia()` (e.g.
      each image must have alt + URL filled).
    - Both `blocks_en` and `blocks_es` must be non-empty after composing
      paragraphs + media (new.js:78-81).
outputs:
  request:
    - "POST `/api/post` with `Content-Type: application/json`,
      `X-Admin-Password: <password>`, body `{ date, blocks_en, blocks_es }`
      (new.js:84-88). Note: `id` is NOT sent — the server generates it."
  on_success:
    - 'Status: "Published. Vercel will redeploy in ~30 seconds." (new.js:95).'
    - Navigate to `/post.html?id=<new_id>` (new.js:96) so the admin can verify
      the result.
  on_failure:
    - 'Status: "Publish failed: <error or status code>" (new.js:89-92). Form
      state preserved; admin can retry.'
  side_effects:
    - Server commits the new post to `posts.json` in the repo on a push to
      `main` (separate from the reader cache-busting strategy).
    - Vercel auto-redeploys; new post visible at me.torrenegra.com in ~30
      seconds.
constraints_observed:
  - Both languages required at publish time — there is no "English-only" or
    "Spanish-only" thought (bilingual-by-default invariant).
  - Media-block validation runs *before* the network call so the admin sees
    field errors without burning a deploy cycle.
  - Date is admin-controlled (not server-stamped) — supports back-dating a
    published thought.
  - Publish button is disabled while uploads are in progress
    (`onUploadingChange` → `publishBtn.disabled = busy`, new.js:45, :51) so a
    half-uploaded media block can't be submitted.
created_at: 2026-05-12T23:13:02Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: active
---

# Step 3a — Publish a new thought

Code: `new.html` + `new.js` + `editor.js` + `blocks.js`.

The page is a single composer for both languages side-by-side. The composer is intentionally insistent that both EN and ES be filled — there's no soft-launch with one language and the other added later; the bilingual model assumes both ship together.

The publish action posts a plain JSON body to `/api/post`. The server is responsible for assigning the id and writing `posts.json`. The UI's redeploy-countdown messaging exists because admins shouldn't expect changes to appear instantly — there's a real ~30-second window between publish and live.

On success the UI navigates to the new thought's detail page, so the admin lands directly in the editable view they'd use for any follow-up tweak.
