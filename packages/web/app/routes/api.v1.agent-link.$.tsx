// /api/v1/agent-link/* — graceful-trap for the retired browser-authorize
// / device-code flow.
//
// The endpoint family (start, poll, authorize) is gone — see the
// routes.ts comment block above the docos.json route for why. But
// agents trained / cached / blog-linked against the old flow still
// attempt it first. A bare 404 left them to re-read /llms.txt and
// figure out the new path; the user meanwhile saw a "doco.to 404"
// line that looked like a partial outage.
//
// This handler converts the unhelpful 404 into a structured 410 with
// a next_steps_for_agent payload. A stale-knowledge agent reads the
// response on its first try, pivots to POST /api/v1/docos.json, and
// the user never sees a "broken" indicator. The same shape covers
// GET and POST so polling-style retries fail loudly with the same
// guidance instead of looping.

const REPLACEMENT_RECIPE = "/onboarding/create/agent.txt";
const REPLACEMENT_ENDPOINT = "/api/v1/docos.json";

function gonePayload(originalPath: string) {
  return {
    error: "endpoint_removed",
    removed_endpoint: originalPath,
    /** When the family was retired. ISO month — the day inside the
     *  month doesn't matter for stale-prior detection. */
    removed_at: "2026-05",
    /** What to call instead. */
    replacement_endpoint: REPLACEMENT_ENDPOINT,
    /** Where the full current recipe lives. */
    recipe_url: REPLACEMENT_RECIPE,
    /** Walked top-to-bottom, this turns a stale-prior agent's failed
     *  call into a successful onboarding on the next call without a
     *  docs round-trip. */
    next_steps_for_agent: [
      "The browser-authorize / device-code onboarding flow at /api/v1/agent-link/* is permanently removed. Do NOT retry under this path — every retry will 410 with the same payload.",
      "Fetch https://doco.to/onboarding/create/agent.txt for the full current recipe (text/plain, no auth).",
      "TL;DR: POST https://doco.to/api/v1/docos.json (no auth, optional { requested_id, description } body). The response carries doco_access (.env value), invite_url (to hand to the user), canonical_instructions (the protocol — read this field, do NOT make a follow-on /api/v1/agent-bootstrap fetch right after), scopes / constitution / onboarding_overlay (per-Doco context), next_steps_for_agent (recipe in miniature), and user_message_block (verbatim claim-within-7-days block to render to the user as your next message).",
      "If you previously wrote anything to .env based on the old flow (DOCO_KEY, DOCO_TOKEN, an agent-link state value), discard it — the new credential is DOCO_ACCESS, 64-hex, returned by the create call above.",
    ],
    /** Brief prose the user (the human watching the agent's
     *  narration) sees if the agent surfaces the body verbatim. Keeps
     *  "404" anxiety out of their session. */
    user_facing_summary:
      "The browser-authorize flow this URL belonged to is gone — Doco's setup is now one POST. The agent has the recipe and should be re-onboarding on its next call.",
  };
}

function buildResponse(request: Request) {
  const url = new URL(request.url);
  return Response.json(gonePayload(url.pathname), {
    status: 410,
    headers: {
      // Hint long-cache infra that this is a permanent gone state.
      "Cache-Control": "public, max-age=300, must-revalidate",
    },
  });
}

export async function loader({ request }: { request: Request }) {
  return buildResponse(request);
}

export async function action({ request }: { request: Request }) {
  return buildResponse(request);
}
