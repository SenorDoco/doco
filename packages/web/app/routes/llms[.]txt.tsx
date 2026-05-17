// /llms.txt — agent-readable entry point at the host root.
//
// Convention: https://llmstxt.org/. Served as text/plain.
import { getPublicBaseUrl } from "@doco/shared";

export async function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = `# Doco

> Doco is AI-native documentation of intents, decisions, rules, and
> actions for software projects. Every meaningful change leaves a
> trail; every user (agent or human) working in a Doco-tracked
> project follows a shared protocol.

If a user just told you something like "let's start using Doco" or
"visit ${new URL(baseUrl).host} and follow the wizard", you're at the
right page. This is the agent-readable entry point.

No SDK, no CLI, no package, no install. Doco is plain HTTP — call it
with whatever HTTP client you already have. Setup is two phases:
**create a Doco** (one POST), then **wire it into the repo** (one .env
line + one doco.md file).

## 1. Create a Doco (no auth required)

    POST ${baseUrl}/api/v1/docos.json
    Content-Type: application/json

    {"requested_id": "<lowercase-kebab>", "description": "<short prose>"}

Both fields are optional. \`requested_id\` is the human-readable URL
id you'd like; the host auto-suffixes (-2, -3, …) on global collision
and writes the actually-used value to \`doco_handle\` in the response.
Omitted id auto-generates as \`doco-<random>\`. Response:

    {
      "doco_id":           "doco_01K…",
      "doco_handle":       "<lowercase-kebab>",
      "doco_url":          "${baseUrl}/<doco_handle>/",
      "doco_slug":         "<owner>/<slug>",
      "doco_key":          "<64-hex>",
      "invite_url":        "${baseUrl}/invite/<64-hex>",
      "invite_expires_at": "<ISO timestamp, 7 days out>"
    }

This is anonymous: the server mints an agent-Principal as the
owner-of-record (no human attached). You hold the \`doco_key\`; share
the \`invite_url\` with the project owner so they can claim
collaboration access too. Both single-use, both ephemeral on the
client side — only \`doco_key\` belongs in long-term storage.

## 2. Wire it into the repo

Write **\`./.env\`** (gitignored — the agent creates a basic
\`.gitignore\` if one isn't already there):

    DOCO_KEY=<doco_key from step 1>

Write **\`./doco.md\`** (committed, non-secret) verbatim:

    # Doco

    This project is tracked in Doco at:
    <doco_url>

    Need access? Ask the project owner for an invite URL.

Write or update **\`./AGENTS.md\`** so it includes the line
\`@./doco.md\` somewhere near the top — that way any agent loading
this repo auto-reads the Doco coordinates. If you also use Claude
Code, write **\`./CLAUDE.md\`** with the single line \`@./AGENTS.md\`
(this is Claude Code's auto-load entry point).

## 3. **GATE**: render the invite block VERBATIM to the user

The /api/v1/docos.json response carries a \`user_message_block\` field
with the exact prose the user must see — the doco_url, the invite_url
(in bold, on its own line), the expiration timestamp, and what
happens if they never claim. **Render it verbatim as your next
message to the user. Don't paraphrase. Don't bury. Don't skip.**

This is a gate, not a side-note. Without claiming the invite, the
user has zero access to their own project's Doco — the agent (you)
holds the only key. If the agent disappears and the invite expires
(7 days), the Doco is orphaned. The block exists so the user can't
miss the call to action.

After rendering the block, you can move on to step 4.

## 4. Commit the bootstrap files to git

\`doco.md\`, \`AGENTS.md\`, \`CLAUDE.md\`, and the \`.gitignore\` entry
need to land in git so a fresh clone / CI runner / teammate's agent
discovers this Doco. **This is a separate action from Doco capture
— capture moved nodes into doco.to via HTTP POSTs, those are
durable on the host; this is the git-level commit so the REPO
carries the Doco coordinates.** Don't conflate the two in your
narration; users will reasonably ask "why push? you said it's in
Doco" if you do.

    git add doco.md AGENTS.md CLAUDE.md .gitignore
    git commit -m "Wire repo into Doco at <doco_url>"

Push per the project's git workflow. If unclear, ASK ("commit + push
now, or do you commit yourself?"). Some Docos carry an "always
commit and push" Rule on Global — read the bootstrap response's
Global scope rules to find out.

## 5. Connect — load the protocol and start

On every session, fetch the protocol and follow it:

    curl -fsS "https://doco.to/agent/\${DOCO_KEY}/bootstrap.json"

The response's \`canonical_instructions\` field carries the four
invariants every reply must follow (query indicator, capture
footer, capture-before-done, tally). Per-prompt search:

    curl -fsS "https://doco.to/agent/\${DOCO_KEY}/search.json?q=<paraphrase>"

Capture (this is the Doco-side write — adds nodes on doco.to, not
to git):

    curl -X POST "https://doco.to/agent/\${DOCO_KEY}/api/decisions.json" \\
      -H "Content-Type: application/json" -d @body.json

## Minting more invites (for teammates, expired URLs, etc.)

Any user (agent or human) holding a valid \`DOCO_KEY\` for the Doco can
mint additional invites with one HTTP call:

    curl -X POST "https://doco.to/agent/\${DOCO_KEY}/api/invites.json" \\
      -H "Content-Type: application/json" \\
      -d '{"expires_in_days": 7}'

Response: \`{invite_url, invite_expires_at, code, doco_url}\`.

\`expires_in_days\` is optional; defaults to 7. Range 1..365. Each
invite is single-use — once redeemed, that URL stops working;
mint a fresh one for each collaborator.

**Don't re-POST \`/api/v1/docos.json\` to "refresh" an invite — that
creates a brand-new Doco.** The correct endpoint when a user asks
"can I have a fresh invite?" is \`/agent/<key>/api/invites.json\`
(API) or the **Invite collaborators** button on the Doco's web page
(human). If you've already created a duplicate Doco by mistake,
only a human can soft-delete it from the Doco's Settings page.

## Cross-environment: same repo, fresh \`.env\`

\`doco.md\` is committed, so any clone has the Doco URL. If \`.env\` is
empty (new machine, fresh container), tell the user:

    "I can see this repo is tracked at <doco_url>, but I need an
    invite to access it. Ask the project owner to either (a) sign
    in at <doco_url> and click 'New invite', or (b) ask their
    already-connected agent to POST
    /agent/<their-DOCO_KEY>/api/invites.json. They'll give you an
    invite URL — paste it back here."

When the user pastes \`https://doco.to/invite/<code>\`, redeem it:

    curl -X POST "${baseUrl}/api/v1/invites/<code>/redeem.json" \\
      -H "Content-Type: application/json" -d '{}'

The response carries:
- \`doco_key\` — write to \`./.env\` as \`DOCO_KEY=<doco_key>\`.
- \`doco_url\` — if the repo has no \`doco.md\`, write one with this URL.
- \`next_steps_for_agent\` — an ordered checklist of file writes +
  the bootstrap fetch. Walk it top-to-bottom; it's the recipe in
  miniature.
- \`user_message_block\` — verbatim prose to render to the user who
  pasted the invite. Tells them you're connected, what files you
  wrote, and how to claim their own access if they want it.

## What NOT to do

- DO NOT print URLs and ask the user to copy/paste anything you can
  fetch yourself. Anything that's \`curl\`-able is your job.
- DO NOT write \`.claude/settings.json\` or any agent-config file.
  Trust-config writes are a privilege-escalation vector and
  conservative classifiers (correctly) block them.
- DO NOT silently degrade when \`.env\` is empty. Stop and ask for an
  invite — the user owns the trust boundary.

## Endpoints

- POST  ${baseUrl}/api/v1/docos.json                                  create a Doco (no auth)
- POST  ${baseUrl}/api/v1/invites/<code>/redeem.json                  redeem an invite (no auth)
- GET   ${baseUrl}/api/v1/agent-bootstrap                             canonical protocol (no per-Doco context)
- GET   ${baseUrl}/api/v1/agent-reference                             deeper reference
- GET   https://doco.to/agent/\${DOCO_KEY}/bootstrap.json              per-Doco bootstrap
- GET   https://doco.to/agent/\${DOCO_KEY}/search.json?q=…             vector search
- GET   https://doco.to/agent/\${DOCO_KEY}/status.json                 freshness + counts
- POST  https://doco.to/agent/\${DOCO_KEY}/api/<type-plural>.json      capture a new node
- POST  https://doco.to/agent/\${DOCO_KEY}/api/invites.json            mint a new invite
- PATCH https://doco.to/agent/\${DOCO_KEY}/api/<type-plural>/<id>.json  extend a node
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
