// JSON-shaped sibling of /onboarding/join/agent. There is no
// state-changing POST here — joining vs creating is the project
// owner's choice in the browser; the agent's HTTP calls are the same
// recipe either way. The endpoint is a discovery handle that tells
// the caller where to actually start.
export function loader() {
  return Response.json({
    status: "info",
    summary:
      "Join-vs-create is a project-owner choice in the browser, not an agent-side fork. Use the same /api/v1/agent-link/{start,poll} recipe.",
    recipe: {
      start: "GET https://doco.to/api/v1/agent-link/start?agent_name=<runtime>&hostname=<host>",
      poll: "GET https://doco.to/api/v1/agent-link/poll?state_nonce=<from-start>",
      details: "https://doco.to/onboarding/create/agent.txt",
    },
    next_steps: [
      "GET /api/v1/agent-link/start (no auth) to get state_nonce + authorize_url + poll_url",
      "Tell the project owner to open authorize_url; they pick existing or create-new in the browser",
      "GET poll_url until response carries access_url; write DOCO_URL=<access_url> to ./.env",
    ],
    related_routes: [
      "/onboarding/join/agent.txt",
      "/onboarding/create/agent.txt",
      "/llms.txt",
      "/api/v1/agent-link/start",
      "/api/v1/agent-link/poll",
    ],
  });
}

export function action() {
  return Response.json(
    {
      error:
        "No state to mutate here. Use POST /api/v1/agent-link/start to begin the browser-authorize handoff.",
    },
    { status: 405 },
  );
}
