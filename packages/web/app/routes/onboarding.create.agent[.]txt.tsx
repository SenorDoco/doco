// /onboarding/create/agent.txt — agent-readable recipe for creating
// a new Doco. Two HTTP calls, two files written to disk, done.
import { getPublicBaseUrl } from "@doco/shared";

export async function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = `Set up Doco for this project — zero-install, zero-prompt recipe for agents.

You talk to ${baseUrl} over plain HTTP. No CLI, no SDK, no install.

The full recipe is two HTTP calls, a handful of files written, and
one git commit. Step 5 is a hard gate: you MUST render the response's
user_message_block to the user before any further onboarding action.

  1. POST /api/v1/docos.json (no auth) → response carries doco_key,
     invite_url, AND a user_message_block field you'll render verbatim
     in step 5.
  2. Write .env (gitignored) with DOCO_KEY=<doco_key>.
  3. Write doco.md (committed) with the doco_url.
  4. Write or update AGENTS.md to @./doco.md, and CLAUDE.md to @./AGENTS.md.
  5. **GATE**: render the response's user_message_block verbatim to the
     user. Don't paraphrase, don't bury, don't skip. The user needs the
     invite URL in hand within 7 days or they lose access to their own
     project's Doco.
  6. Apply the protocol now: GET https://doco.to/agent/\${DOCO_KEY}/bootstrap.json.
  7. Commit the bootstrap files to git (doco.md, AGENTS.md, CLAUDE.md,
     .gitignore). This is a SEPARATE action from Doco capture — see
     step 7 below for the framing.

Step 1 — create the Doco:

    curl -fsS -X POST ${baseUrl}/api/v1/docos.json \\
      -H "Content-Type: application/json" \\
      -d '{"requested_id": "<lowercase-kebab>", "description": "<short prose>"}'

    Response (JSON):
    {
      "doco_id":           "doco_01K…",
      "doco_handle":       "<lowercase-kebab>",
      "doco_url":          "${baseUrl}/<lowercase-kebab>/",
      "doco_slug":         "<owner>/<slug>",
      "doco_key":          "<64-hex>",
      "invite_url":        "${baseUrl}/invite/<64-hex>",
      "invite_expires_at": "<ISO timestamp, 7 days out>"
    }

Both fields in the request are optional. \`requested_id\` is the
human-readable URL id you'd like; the host auto-suffixes (-2, -3, …)
on global collision and writes the actually-used value to
\`doco_handle\` in the response. Omitted id auto-generates. The
legacy field name \`slug\` is still accepted as an alias.

Step 2 — write ./.env (gitignored). Create the file if missing; if the
project already has an .env, append to it without clobbering existing
lines. Also ensure .env is in .gitignore:

    DOCO_KEY=<doco_key from step 1>

Step 3 — write ./doco.md (committed, non-secret) verbatim:

    # Doco

    This project is tracked in Doco. Decisions, intents, rules, and
    history live at:

    **<doco_url>**

    Need access? Ask the project owner for an invite URL.

Step 4 — make agent surfaces auto-load doco.md.

    ./AGENTS.md (committed; the cross-agent convention from
    https://agents.md). If it doesn't exist, write:

        # AGENTS.md

        This repository uses Doco for AI-native documentation. The
        per-project coordinates live in:

        @./doco.md

        Every agent working on this repo fetches the per-Doco
        protocol from doco.to before responding to any user message.
        See the canonical at https://doco.to/api/v1/agent-bootstrap.

    If AGENTS.md already exists, ADD the line "@./doco.md" near the
    top — don't replace the existing content.

    ./CLAUDE.md (committed; Claude Code's auto-load entry point).
    Whether or not the user runs Claude Code, write this one-liner:

        @./AGENTS.md

Step 5 — **HAND THE USER THE INVITE URL. THIS IS A GATE, NOT A
SIDE-NOTE.** Render it BEFORE any scope work, BEFORE bootstrapping
the protocol, BEFORE doing anything else.

The /api/v1/docos.json response includes a \`user_message_block\`
field. Render it VERBATIM as your next message to the user:

    [whatever the response's user_message_block field contained]

Don't paraphrase. Don't summarize. Don't shorten. The block carries:
- the doco_url (so they can browse later)
- a bolded "claim within 7 days" call to action
- the invite_url, on its own line, in bold
- the expiration timestamp
- what happens if they never claim (you keep working; they lose web
  access + invite-minting + your-revoke ability)

Why this is a gate: without claiming, the user has zero access to
their own project's Doco. The agent (you) holds the only key. If
the agent disappears (.env wiped, container destroyed) and the
invite expires, the Doco is orphaned. Burying the invite in chat
later is how that happens. Render it first.

After the user-message-block, you can move on to step 6.

If you onboard again later in the same session (extremely unlikely
but possible), repeat the invite block. If the user has already
accepted, the bootstrap response's onboarding_overlay will reflect
that and you can skip the reminder.

Step 6 — apply the protocol now. DON'T restart the session, DON'T ask
the user to /clear. You have DOCO_KEY in hand; fetch the canonical and
follow it:

    curl -fsS "https://doco.to/agent/\${DOCO_KEY}/bootstrap.json"

Read the \`canonical_instructions\` field. From your next reply
onward, follow the four invariants. For Claude Code, hooks auto-load
on the next session start — \`/hooks\` to approve is a one-time-per-
repo action the user can do whenever.

Step 7 — commit the bootstrap files to git.

\`doco.md\`, \`AGENTS.md\`, \`CLAUDE.md\`, and the \`.gitignore\` entry
you just added need to land in git. Otherwise: a fresh clone, a CI
runner, or any teammate's agent landing in this repo has no idea this
Doco exists. The files are the discoverability layer.

**This is a separate action from Doco capture.** Capture moved nodes
INTO doco.to via HTTP POSTs — those are durable on the host, no git
involvement. Step 7 is git-level: commit local files so the REPO
carries the Doco coordinates. Don't conflate the two in your
narration to the user.

Suggested commit:

    git add doco.md AGENTS.md CLAUDE.md .gitignore
    git commit -m "Wire repo into Doco at <doco_url>"

Then push per the project's git workflow. If you don't know the
project's commit/push convention (some Docos carry a "always commit
and push" Rule on Global; others are ask-before-pushing), ASK before
pushing. Example:

    "I've written doco.md, AGENTS.md, and CLAUDE.md to the repo so
    future clones and other agents discover this Doco. Want me to
    commit + push to main now, or do you commit yourself?"

When you frame this to the user, name the two things separately —
"the Doco nodes I captured live on doco.to and are already saved
there; these local files are the repo's discoverability layer and
need a git commit." That distinction prevents the "why are you
asking to push? you said it's already in Doco" confusion.

That's it. Two HTTP calls, four files written, one git commit. No
browser prompts, no permission cascades, no session restart.

For the COLLABORATION JOIN flow (user is on a new env or wants to
invite a teammate), see /llms.txt — the redeem-an-invite recipe is
two HTTP calls.
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
