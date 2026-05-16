// /llms.txt — agent-readable entry point at the host root.
//
// Convention: https://llmstxt.org/. Served as text/plain. The companion
// signals (<link rel="alternate"> + <meta name="ai-instructions">) on
// every page point agents here so they don't have to guess.
//
// Why this file exists: an agent told "visit doco.to and follow the
// wizard" in a fresh project (no AGENTS.md, no .env, no Doco training
// data) used to fetch the homepage, /onboarding/create, /new-doco,
// then probe /agent /docs /onboarding/agent /sitemap.xml /robots.txt
// /llms.txt — every fallback. All 404. This file is the first one
// that's no longer 404.
import { getPublicBaseUrl } from "@doco/shared";

export async function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = `# Doco

> Doco is AI-native documentation of intents, decisions, rules, and
> actions for software projects. Every meaningful change leaves a
> trail; every agent working in a Doco-tracked project follows a shared
> protocol.

If the project owner just told you something like "let's start using
Doco" or "visit ${new URL(baseUrl).host} and follow the wizard", you've
reached the right document. This is the agent-readable entry point.

There is no SDK to install, no CLI to install, no package to download.
Doco is plain HTTP — you call it with whatever HTTP client you already
have.

The same three-step recipe below works whether the project owner wants
to **join an existing Doco** (one they already have on this host) OR
**create a brand-new Doco** for this project. The agent's HTTP calls
are identical; the choice happens in the browser when the project owner
clicks Authorize.

## Bootstrap Doco for this project (no install required)

Run this from the project root — these are plain HTTP calls, no install
needed.

1. Ask the host for a browser-authorization handoff — a plain GET so
   conservative agent classifiers don't flag it as a state-mutating POST:

       GET ${baseUrl}/api/v1/agent-link/start?agent_name=<your-runtime>&hostname=<host>

   Response: \`{ state_nonce, short_code, authorize_url, poll_url,
   interval_seconds, expires_at }\`. The \`poll_url\` already has the
   \`state_nonce\` baked in as a query param — fetch it as-is.

2. Open <authorize_url> yourself — DON'T ask the project owner to
   copy-paste. Their terminal can reach their default browser:
   \`open\` (macOS), \`xdg-open\` (Linux), \`start\` (Windows). Try them
   in order; fall back to printing the URL only if none exist (remote
   sandboxes). Then tell the project owner what to do in the browser
   that just popped up: sign in, pick an existing Doco or enter a slug
   for a new one, click Authorize. Wait.

3. Poll \`poll_url\` (the URL from step 1, already shaped as
   \`${baseUrl}/api/v1/agent-link/poll?state_nonce=<nonce>\`) every
   \`interval_seconds\`:

       GET <poll_url>

   Response stays \`{ status: "pending" }\` until the owner acts, then
   flips to \`{ status: "approved", access_url, owner_slug, doco_slug,
   doco_id }\`.

4. Write \`DOCO_URL=<access_url>\` to \`./.env\` (gitignored). The
   access URL is a single opaque URL of the shape
   \`${baseUrl}/agent/<credential>/\` — credential and identity
   together in the path. No \`Authorization\` header, no separate
   token to manage.

5. Write \`AGENTS.md\` and \`CLAUDE.md\` (a one-line shim) into the
   repo root so future sessions auto-load the protocol. Templates
   live at ${baseUrl}/onboarding/create/agent.txt — fetch and write
   them verbatim.

6. Apply the protocol NOW, in this same session. Don't tell the
   project owner to /clear or restart — you already have
   \${DOCO_URL}; fetch the canonical inline and follow it:

       curl -fsS "\${DOCO_URL}bootstrap.json"

   Read the \`canonical_instructions\` field. From your next reply
   onward, follow the four invariants. For Claude Code, hooks
   auto-load on the NEXT session start; \`/hooks\` to approve is a
   one-time-per-repo action the project owner can do whenever.

Detail: ${baseUrl}/onboarding/create/agent.txt

## I'm already in a Doco-tracked project

If \`./.env\` has \`DOCO_URL\`, fetch the canonical agent instructions
at the start of every task:

    curl -fsS \${DOCO_URL}bootstrap.json

The \`canonical_instructions\` field is the protocol — query indicator,
capture footer, tally line, all of it.

Before writing about a task, query the project memory:

    curl -fsS "\${DOCO_URL}search.json?q=<task-paraphrase>"

The credential lives in the URL path; no headers, no env-var gymnastics.

## What NOT to do

- Don't try to "follow the wizard" by curl-ing /onboarding/create — the
  React app is human-facing. The agent path is /api/v1/agent-link/start
  above.
- Don't write Doco YAML by hand. The POST /api/<type>.json endpoints
  handle ULID generation, file writing, and reindexing in one
  round-trip.
- Don't silently degrade if the host or access URL is broken. The
  canonical instructions explain what to do (stop and ask the project
  owner).

## Endpoints

- GET  ${baseUrl}/api/v1/agent-link/start   begin browser authorization (no auth)
- GET  ${baseUrl}/api/v1/agent-link/poll    wait for approval (no auth)
- GET  ${baseUrl}/api/v1/agent-bootstrap    canonical agent protocol (slim, public)
- GET  ${baseUrl}/api/v1/agent-reference    deeper reference (model, capture flow)
- GET  \${DOCO_URL}bootstrap.json           per-Doco bootstrap (access URL required)
- GET  \${DOCO_URL}search.json?q=…          vector search for prior context
- GET  \${DOCO_URL}status.json              freshness + counts (footer source)
- POST \${DOCO_URL}api/<type-plural>.json   capture a new node
- PATCH \${DOCO_URL}api/<type-plural>/<id>.json   extend an existing node
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
