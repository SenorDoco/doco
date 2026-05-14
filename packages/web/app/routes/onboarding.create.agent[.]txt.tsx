import { getPublicBaseUrl } from "@doco/shared";
import { HOST_BOOTSTRAP_USERNAME } from "~/lib/bootstrap.server";

/**
 * /onboarding/create/agent.txt — agent-optimized version of the wizard's
 * agent path. Plain-prose form spec + endpoint + field constraints so a
 * single GET + single POST is enough; agents don't have to regex past
 * Tailwind class names in the HTML page. Linked from the HTML version via
 * <link rel="alternate" type="text/plain" ...>.
 */
export function loader({ request }: { request: Request }) {
  const baseUrl = getPublicBaseUrl(request);
  const body = renderText(baseUrl);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function renderText(baseUrl: string): string {
  return `# Doco — Create a Doco as an agent

You are an AI agent that wants to start a new Doco for a project. This
endpoint creates an UNCLAIMED Doco you can write to immediately. The owner
you're collaborating with claims it later via a one-time URL.

ENDPOINT
  POST ${baseUrl}/onboarding/create/agent.json
  Content-Type: application/x-www-form-urlencoded

  Always returns JSON. The HTML form at /onboarding/create/agent posts to
  itself and renders a success page — don't use it from a non-browser
  client; the .json endpoint is what you want.

FIELDS
  doco_slug           required   lowercase kebab-case, matches [a-z0-9_-]+
                                 If the slug is taken, the server creates
                                 <slug>-2 / <slug>-3 / … silently — read
                                 the actual slug back from "doco_slug" in
                                 the response (don't assume it matches
                                 what you posted).
  description         optional   one or two sentences
  visibility          optional   "private" (default) or "public"
  agent_display_name  optional   what to call this agent (default "my-agent")
  model               optional   your model ID, e.g. "claude-opus-4-7"
  provider            optional   your provider, e.g. "anthropic"

SUCCESS RESPONSE (HTTP 200, application/json)
  {
    "ok": {
      "doco_url":          "${baseUrl}/${HOST_BOOTSTRAP_USERNAME}/<slug>",
      "doco_slug":         "<slug>",
      "session_token":     "<DOCO_TOKEN — store immediately, not shown again>",
      "claim_url":         "${baseUrl}/claim/<token>",
      "claim_status_url":  "${baseUrl}/claim/<token>.json",
      "claim_expires_at":  "<ISO-8601 timestamp>",
      "principal":         { "id": "...", "username": "...", "display_name": "..." },
      "canonical_instructions": "<the slim ~1.2K-token base protocol — query indicator at TOP, footer_lines after writes, tally at LAST line. Same text /api/v1/agent-bootstrap returns.>",
      "agent_instructions": {
        "claim_reminder":          "<rule: render claim_reminder_template ABOVE the canonical tally until claimed>",
        "claim_reminder_template": "<ready-to-paste markdown line with the claim URL>",
        "claim_detection":         "<rule: owner_slug from search.json/status.json flips on claim — no separate poll needed>",
        "status_url":              "${baseUrl}/${HOST_BOOTSTRAP_USERNAME}/<slug>/status.json",
        "scope_setup":             "<STEP 1 — decide-and-CONFIRM; recommend starter set adrs + user-flows + 1–2 custom; pass watched=true during onboarding; never materialize before the project owner confirms>",
        "scope_setup_url":         "${baseUrl}/${HOST_BOOTSTRAP_USERNAME}/<slug>/scopes/new?onboarding=1",
        "watched_explainer":       "<inline definition of 'watched' (soft attention signal, not enforcement); onboarding defaults to watched=true; ADR-137bis applies post-onboarding>",
        "scope_population":        "<STEP 2 — onboarding is NOT done when scopes exist; drive >=1 real node into each scope before declaring done, or wait for explicit 'defer the rest'>"
      }
    }
  }

ERROR RESPONSE (HTTP 200, application/json)
  { "error": "<reason>" }

AFTER SUCCESS
  1. Store DOCO_TOKEN where your runtime can read it (e.g. ./.env).
     Also stamp DOCO_HOST=${baseUrl} and DOCO_SLUG=${HOST_BOOTSTRAP_USERNAME}/<slug>
     so tools (and the SessionStart/UserPromptSubmit hooks in future sessions)
     can find the host and the right Doco.
  2. Keep working — the Doco is fully writable. Do NOT block on the claim.
  3. canonical_instructions IS your base protocol. Read it once and follow
     it on every reply:
       • TOP of every reply — query indicator (Querying... / <N> relevant
         nodes found (<X.Xs>)). This IS your connection heartbeat — every
         turn proves the host is reachable.
       • AFTER every write — footer_lines verbatim from the POST response.
       • LAST LINE of every reply — tally:
           [🔮 Doco] <owner>/<doco>: **<N>** node(s) added/updated
  4. ON TOP of canonical, while owner_slug === "${HOST_BOOTSTRAP_USERNAME}":
     render the claim_reminder_template line ABOVE the canonical tally,
     replacing the <countdown> placeholder with the live time remaining
     until claim_expires_at (e.g. "in 29 days", "in 2 hours"). The tally
     stays the absolute last line. Two trailing lines:
       [[🔮 Doco]](<claim_url>) Claim this Doco: <claim_url> — expires in <countdown>.
       [🔮 Doco] <owner>/<doco>: **<N>** node(s) added/updated
  5. Claim detection is free — the canonical's top-of-reply search query
     already returns owner_slug. When it flips from "${HOST_BOOTSTRAP_USERNAME}"
     to the owner's slug, the Doco is claimed: drop the claim reminder and
     start using the new <owner>/<doco> in your tally. The legacy
     claim_status_url endpoint still works for explicit polling but is
     redundant.
  6. Read AGENT.md / CLAUDE.md in your repo for project-specific conventions
     (authentication, attribution, the person-ancestry invariant).
  7. Onboarding has TWO steps. Don't stop after step 1.
     STEP 1 — Define scopes at
       ${baseUrl}/${HOST_BOOTSTRAP_USERNAME}/<slug>/scopes/new?onboarding=1
       Decide-and-CONFIRM with the project owner. Recommended starter
       set: adrs + user-flows + 1–2 custom scopes named for the
       project's actual subject areas. Pass watched=true on every
       scope created during onboarding (project owner is in the room
       picking them on purpose). See agent_instructions.scope_setup +
       agent_instructions.watched_explainer.
     STEP 2 — Drive real content into each scope. For EACH scope you
       just created, ask the project owner what they want to capture
       first (the most important ADR, the load-bearing user flow,
       the contract that's in their head but not in the repo).
       Capture >=1 real node per scope before declaring onboarding
       done. Empty scopes are the failure mode this step exists to
       prevent — scope shells with no nodes are documentation
       theater. Only stop when each scope has content OR the project
       owner explicitly says "defer the rest for now." See
       agent_instructions.scope_population.

NOTE ON ADR PROMOTION
  When capturing Decisions via POST /<owner>/<doco>/api/decisions.json,
  do NOT pass auto_number reflexively. Set is_adr: true only when the
  Decision is a structural choice (contract, convention, invariant)
  that will be cited later. Bug fixes, implementation polish, and
  defaults-tweaks are plain Decisions — leave is_adr false.

RELATED AGENT-OPTIMIZED URLS
  GET  ${baseUrl}/onboarding/join/agent.txt    join an existing Doco instead
  GET  ${baseUrl}/agents/new.txt               get an invite as an agent

CONVENTION
  Every agent-facing page on this host has a .txt sibling. To get the
  agent-optimized version of any URL, append ".txt". The HTML version
  also advertises its .txt sibling via <link rel="alternate"
  type="text/plain" href="..."> in the <head>.
`;
}
