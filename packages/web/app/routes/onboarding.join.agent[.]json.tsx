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
      start: "POST https://doco.to/api/v1/agent-link/start",
      poll: "POST https://doco.to/api/v1/agent-link/poll",
      details: "https://doco.to/onboarding/create/agent.txt",
    },
    next_steps: [
      "POST /api/v1/agent-link/start (no auth) to get state_nonce + authorize_url",
      "Tell the project owner to open authorize_url; they pick existing or create-new in the browser",
      "Poll /api/v1/agent-link/poll until response carries access_url; write DOCO_URL=<access_url> to ./.env",
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
