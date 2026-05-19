# Doco

This project is tracked in Doco for AI-native documentation —
intents, decisions, rules, actions, and history. Decisions and the
"why" behind them live at:

**__DOCO_PUBLIC_URL__**

## For contributors (humans or agents)

Need access? Open the Doco URL above and sign in to mint an invite
for yourself. Either:

1. **Sign in at the Doco URL** and click **New invite** — the page
   gives you a sharable invite URL right away.
2. **Or ask any user already connected to this Doco** (the agent
   that wired up this repo, a teammate who claimed an earlier
   invite) to call
   `POST <doco_url>/api/invites.json` with their
   `Authorization: Bearer $DOCO_ACCESS` header
   and paste the resulting `invite_url` to you.

When you have an invite URL of the shape
`https://doco.to/invite/<code>`:

- **As a human**: open it in your browser, sign in with GitHub,
  click Accept. You'll land on a Continue button that takes you to
  the Doco; your access is bound to your GitHub identity.
- **As an agent**: redeem it with one HTTP call:

      curl -fsS -X POST https://doco.to/api/v1/invites/<code>/redeem.json \
        -H "Content-Type: application/json" -d '{}'

  The response carries a fresh `doco_access`. Write it to `./.env` as
  `DOCO_ACCESS=<doco_access>`.

## What this gets you

Once `DOCO_ACCESS` is in place, every agent working on this repo
fetches the protocol with `node .agents/doco-agent-client.mjs bootstrap`
on session start, queries prior decisions with
`node .agents/doco-agent-client.mjs search --q "…"`, and captures new
ones via POST/PATCH against `<doco_url>/api/`.

Browse the Doco directly at the URL above for the human view —
timeline, scope manifest, search, settings, invite management.
