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

> Doco is AI-native documentation of intents, decisions, rules, actions,
> and reasoning for software projects. Every meaningful change leaves a
> trail; every agent working in a Doco-tracked project follows a shared
> protocol.

If the project owner just told you something like "let's start using
Doco" or "visit ${new URL(baseUrl).host} and follow the wizard", you've
reached the right document. This is the agent-readable entry point.

## Bootstrap Doco for a new project

The project owner wants Doco installed in their repo and you set up as
an agent on it. From the project root, run:

    doco login --host ${baseUrl} --create <slug>

The CLI opens the owner's browser to a one-screen authorize prompt. On
approval, it creates the Doco, mints an agent token, and writes
DOCO_HOST + DOCO_TOKEN + DOCO_SLUG to ./.env in the project root. Then:

    doco install-agent-bootstrap

This installs AGENTS.md, CLAUDE.md (Claude-Code shim), and .claude/
hook scripts. Restart your session afterwards.

Detail (plain text):  ${baseUrl}/onboarding/create/agent.txt
Detail (HTML):        ${baseUrl}/onboarding/create/agent

If \`doco\` is not on $PATH, install it: \`npm i -g @doco/cli\` (or use
\`npx @doco/cli login …\` for a one-shot).

## I'm already in a Doco-tracked project

If \`./.env\` has DOCO_HOST + DOCO_TOKEN + DOCO_SLUG, fetch the canonical
agent instructions at the start of every task and follow them:

    curl -s "$DOCO_HOST/api/v1/agent-bootstrap?slug=$DOCO_SLUG" \\
      -H "Authorization: Bearer $DOCO_TOKEN"

The \`canonical_instructions\` field is the protocol — query indicator,
capture footer, tally line, all of it.

## What NOT to do

- Don't try to "follow the wizard" by curl-ing /onboarding/create. That
  flow is human-facing and the page is a React app; the agent-facing
  path is the CLI above.
- Don't write Doco YAML by hand. The \`doco capture\` CLI and the
  POST /api/<type>.json endpoints handle ULID generation, file
  writing, and reindexing in one round trip.
- Don't silently degrade if the host or token is broken. The canonical
  instructions explain what to do (stop and ask the project owner).

## Endpoints

- ${baseUrl}/api/v1/agent-bootstrap         canonical agent protocol (slim)
- ${baseUrl}/api/v1/agent-reference         deeper reference (model, capture flow)
- ${baseUrl}/<owner>/<doco>/search.json     vector search for prior context
- ${baseUrl}/<owner>/<doco>/status.json     freshness + counts (footer source)
`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
