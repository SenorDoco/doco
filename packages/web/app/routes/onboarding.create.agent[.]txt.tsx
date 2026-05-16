// /onboarding/create/agent.txt — agent-readable recipe for creating a
// new Doco. No install, no CLI; the agent uses plain HTTP and writes
// two files (./.env + ./AGENTS.md) into the project root.
import { getPublicBaseUrl } from "@doco/shared";

export async function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = `Set up Doco for this project — zero-install recipe for agents.

This same recipe handles BOTH cases — bind this agent to a Doco the
project owner already has, OR create a brand-new Doco. The HTTP calls
are identical; the project owner picks which in the browser at step 2.

You'll talk to ${baseUrl} over plain HTTP. There is no CLI to install
and no SDK to import.

Step 1 — start a browser-authorization handoff (no auth, plain GET so
conservative classifiers don't flag it as state-mutating):

    curl -fsS '${baseUrl}/api/v1/agent-link/start?agent_name=<your-runtime>&hostname=<host>'

Response (JSON):
    {
      "state_nonce":      "<opaque, you'll poll with this>",
      "short_code":       "<8-char human-readable code>",
      "authorize_url":    "${baseUrl}/cli/authorize?state=<state_nonce>",
      "poll_url":         "${baseUrl}/api/v1/agent-link/poll?state_nonce=<nonce>",
      "interval_seconds": 2,
      "expires_at":       "<ISO timestamp; 10-minute window>"
    }

Step 2 — open the authorize_url in the project owner's browser, then wait:

DON'T print the URL and ask them to copy-paste. Open it yourself first.
Their terminal can reach their default browser:

    # Try in order; whichever exits 0 wins. \`command -v\` keeps the call
    # silent on platforms where the opener doesn't exist.
    if command -v open >/dev/null 2>&1; then
      open "<authorize_url>"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "<authorize_url>"
    elif command -v start >/dev/null 2>&1; then
      start "<authorize_url>"
    else
      echo "Open this URL in your browser: <authorize_url>"
    fi

In a remote sandbox (Codex web, GitHub Coding Agent, Anthropic web)
none of the openers exist; the else branch prints the URL and the
project owner opens it manually. Locally (Claude Code on a Mac, Cursor
on a laptop) the first branch fires and the browser pops up on its
own.

Tell the project owner what just happened so they look at the browser:

    "I opened the authorize page in your browser — sign in if asked,
    pick an existing Doco (or enter a slug to create a new one), and
    click Authorize. I'll wait."

Don't loop. Don't retry on your own. Wait for them to confirm or for
step 3's poll to flip status.

Step 3 — poll for approval (plain GET; the poll_url from step 1 already
has ?state_nonce=… baked in, fetch it as-is):

    curl -fsS '<poll_url>'

Responses:
    {"status": "pending"}                  — owner hasn't acted yet, sleep interval_seconds and re-poll
    {"status": "approved", "access_url": "${baseUrl}/agent/<credential>/",
     "owner_slug": "...", "doco_slug": "...", "doco_id": "..."}
    {"status": "denied"}                   — owner clicked Deny; stop and explain
    {"status": "expired"}                  — 10 minutes passed; start over from step 1
    {"status": "already_consumed"}         — second poll for the same nonce (single-use)

Step 4 — write the access URL to ./.env:

    DOCO_URL=<access_url-from-step-3>

The access URL is the only secret. Treat it like a Slack webhook URL.
Keep it out of commits; the line above lives in ./.env (gitignored).
There is no \`DOCO_TOKEN\`, no \`DOCO_ID\`, no \`Authorization\` header
— identity and credential are encoded together in the URL path.

Step 5 — drop AGENTS.md and CLAUDE.md into the repo root.

AGENTS.md (committed, non-secret):

    # Doco — this project

    This project uses **Doco** for AI-native documentation. Before
    responding to any user message, fetch the canonical agent
    instructions:

        curl -fsS \${DOCO_URL}bootstrap.json

    Read the \`canonical_instructions\` field. Follow the four invariants
    (query indicator, capture footer, capture-before-done, tally line)
    on every reply.

    Per-prompt search:

        curl -fsS "\${DOCO_URL}search.json?q=<task-paraphrase>"

    If \`./.env\` doesn't have \`DOCO_URL\`, or the host is unreachable,
    do not start the user's task. Surface the failure and wait — see
    the canonical's "If the bootstrap fetch fails" section for the
    recovery table.

CLAUDE.md (committed; Claude Code auto-loads it):

    @./AGENTS.md

Step 6 — restart your agent session.

    Claude Code: /hooks to approve the SessionStart + UserPromptSubmit
    hooks (if you also installed .claude/settings.json), then /clear.
    Other runtimes: just start a fresh session; the next bootstrap will
    pull the fresh credentials from ./.env.

That's it. No install. No package. Just three POSTs (one start, N polls,
one to begin captures) and two files written to disk.

Common pitfalls:

- The browser auth URL is single-use per state_nonce. If the owner
  clicks Authorize twice or you poll after a successful poll, you'll
  see "already_consumed". Re-run step 1 to start over.
- The 10-minute window starts at /start. If the owner takes longer,
  start over.
- The access URL is bound to one Doco. If you need to switch Docos,
  re-onboard from step 1; you'll get a different access URL.
- Sandboxes that block \`doco.to\` will fail at step 1 with
  HTTP_STATUS:000. That's a network-policy issue — ask the project
  owner to allowlist \`doco.to\` in their agent runtime's network
  settings. Re-onboarding won't help.
`;
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
