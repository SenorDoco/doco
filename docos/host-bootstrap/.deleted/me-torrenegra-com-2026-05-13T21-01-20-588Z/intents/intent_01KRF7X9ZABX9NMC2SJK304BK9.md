---
id: intent_01KRF7X9ZABX9NMC2SJK304BK9
doco_id: doco_01KRF55AR2J8S8CE48FR86NHT7
node_type: intent
summary: Admin (Alex) manages thoughts — publish, edit, or delete — from a
  password-gated UI that commits to the repo and auto-deploys.
title: Admin manages thoughts
created_at: 2026-05-12T23:21:17.546Z
created_by: principal_01KRF55AR9H0RDQREGYH7WQWMQ
lifecycle: active
---

**Who:** Alex (the site owner), authenticating with a shared admin password held in `sessionStorage.admin_pw` and sent on every request as `X-Admin-Password`.

**Outcome they want:** publish a new thought, fix an existing one, or remove an obsolete one — without leaving the browser.

**Surface:**
- `/admin.html` — gated landing: sign-in lock, list of thoughts, branching choice (new / open / delete).
- `/new.html` — dedicated publish form.
- `/post.html?id=<id>` — when authed, exposes an inline Edit/Delete toolbar over the reader view (same page the reader flow uses).
- API: `POST /api/verify`, `POST /api/post`, `PUT /api/post`, `DELETE /api/post?id=<id>`.

**Pipeline:** the API commits the change to `posts.json` in the repo; Vercel auto-redeploys on push to `main`. Every success path surfaces "Vercel will redeploy in ~30 seconds." so the admin knows the round-trip latency.

**Non-goals:**
- Multi-author / role-based admin — there is exactly one admin (Alex), one password.
- Draft state — there is no "save as draft"; a thought is either published or it doesn't exist.
- Reader-side flow (browsing the feed, reading a thought) — separate Intent.
- Newsletter management — outside this flow.

**Success looks like:** Alex unlocks, picks a branch (publish / edit / delete), the API responds 2xx, the UI flips to a success state with the redeploy message, and within ~30 seconds the change is live on me.torrenegra.com.
