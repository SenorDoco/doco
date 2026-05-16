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

## Bootstrap Doco for a new project (no install required)

The project owner wants Doco installed in their repo and you set up as
an agent on it. Run this from the project root — these are plain HTTP
calls, no install needed.

1. Ask the host for a browser-authorization handoff:

       POST ${baseUrl}/api/v1/agent-link/start
       Content-Type: application/json

       {"agent_name": "<your-runtime-name>", "hostname": "<host>"}

   Response: \`{ state_nonce, short_code, authorize_url, poll_url,
   interval_seconds, expires_at }\`.

2. Tell the project owner: "Open <authorize_url> in your browser. Sign
   in, name the new Doco, click Authorize." Wait.

3. Poll \`poll_url\` every \`interval_seconds\`:

       POST <poll_url>
       Content-Type: application/json

       {"state_nonce": "<from-step-1>"}

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

- ${baseUrl}/api/v1/agent-link/start    begin browser authorization (no auth)
- ${baseUrl}/api/v1/agent-link/poll     wait for approval (no auth)
- ${baseUrl}/api/v1/agent-bootstrap     canonical agent protocol (slim, public)
- ${baseUrl}/api/v1/agent-reference     deeper reference (model, capture flow)
- \${DOCO_URL}bootstrap.json            per-Doco bootstrap (access URL required)
- \${DOCO_URL}search.json?q=…           vector search for prior context
- \${DOCO_URL}status.json               freshness + counts (footer source)
- \${DOCO_URL}api/<type-plural>.json    POST to capture a new node
- \${DOCO_URL}api/<type-plural>/<id>.json  PATCH to extend an existing node
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
