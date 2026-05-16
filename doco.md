# Doco

This project is the meta-Doco — Doco's own Doco. Decisions, intents,
rules, and history about Doco-the-product live at:

**https://doco.to/by-id/doco_01KR441EA0ZDMF0N5DY38GSVS3/**

## For contributors (humans or agents)

Need access? Ask the project owner for an invite URL. They can mint
one in two ways:

1. Sign in at the Doco link above, click **New invite**, and share
   the resulting URL with you.
2. Ask an already-connected agent in this repo to call
   `POST https://doco.to/agent/<their-DOCO_KEY>/api/invites.json`
   and paste the resulting `invite_url` to you.

When you have an invite URL of the shape
`https://doco.to/invite/<code>`:

- **As a human**: open it in your browser, sign in with GitHub,
  click Accept. You'll see your personal `DOCO_KEY` on the success
  page — paste it into `./.env`.
- **As an agent**: redeem it with one HTTP call:

      curl -fsS -X POST https://doco.to/api/v1/invites/<code>/redeem.json \
        -H "Content-Type: application/json" -d '{}'

  The response carries a fresh `doco_key`. Write it to `./.env` as
  `DOCO_KEY=<doco_key>`.

## What this gets you

Once `DOCO_KEY` is in place, every agent working on this repo
fetches the protocol from `https://doco.to/agent/${DOCO_KEY}/bootstrap.json`
on session start, queries prior decisions via
`https://doco.to/agent/${DOCO_KEY}/search.json?q=…`, and captures new
ones via POST/PATCH against `https://doco.to/agent/${DOCO_KEY}/api/`.

Browse the Doco directly at the URL above for the human view —
timeline, scope manifest, search, settings, invite management.
