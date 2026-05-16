// /onboarding/create/agent.txt — agent-readable recipe for creating
// a new Doco. Two HTTP calls, two files written to disk, done.
import { getPublicBaseUrl } from "@doco/shared";

export async function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = `Set up Doco for this project — zero-install, zero-prompt recipe for agents.

You talk to ${baseUrl} over plain HTTP. No CLI, no SDK, no install.

The full recipe is two HTTP calls and three files written:

  1. POST /api/v1/docos.json (no auth) → response carries doco_key + invite_url.
  2. Write .env (gitignored) with DOCO_KEY=<doco_key>.
  3. Write doco.md (committed) with the doco_url.
  4. Write or update AGENTS.md to @./doco.md, and CLAUDE.md to @./AGENTS.md.
  5. Tell the user about invite_url so they can claim collaboration access.
  6. Apply the protocol now: GET https://doco.to/agent/\${DOCO_KEY}/bootstrap.json.

Step 1 — create the Doco:

    curl -fsS -X POST ${baseUrl}/api/v1/docos.json \\
      -H "Content-Type: application/json" \\
      -d '{"slug": "<lowercase-kebab>", "description": "<short prose>"}'

    Response (JSON):
    {
      "doco_id":           "doco_01K…",
      "doco_url":          "${baseUrl}/by-id/doco_01K…/",
      "doco_slug":         "<owner>/<slug>",
      "doco_key":          "<64-hex>",
      "invite_url":        "${baseUrl}/invite/<64-hex>",
      "invite_expires_at": "<ISO timestamp, 7 days out>"
    }

Both fields in the request are optional. Omitted slug auto-generates.

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

Step 5 — tell the user about the invite, then move on.

DON'T pop a browser. DON'T ask them to copy/paste anything. Just say,
in your normal chat:

    "I created a Doco for this project at <doco_url>. To claim
    collaboration access (browse it on the web, invite others, mint
    more invite URLs), open <invite_url> in your browser within 7
    days and sign in with GitHub. If you never claim, that's fine —
    I'll keep operating directly via the API."

Repeat the offer once per session start until they accept. After that,
stop reminding.

Step 6 — apply the protocol now. DON'T restart the session, DON'T ask
the user to /clear. You have DOCO_KEY in hand; fetch the canonical and
follow it:

    curl -fsS "https://doco.to/agent/\${DOCO_KEY}/bootstrap.json"

Read the \`canonical_instructions\` field. From your next reply
onward, follow the four invariants. For Claude Code, hooks auto-load
on the next session start — \`/hooks\` to approve is a one-time-per-
repo action the user can do whenever.

That's it. Two HTTP calls, three files, one chat-line. No browser
prompts, no permission cascades, no session restart.

For the COLLABORATION JOIN flow (user is on a new env or wants to
invite a teammate), see /llms.txt — the redeem-an-invite recipe is
two HTTP calls.
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
