// JSON-shaped sibling of /onboarding/join/agent (per the agent-route
// policy enforced by check-agent-route-policy.mjs). There is no
// state-changing POST here — agents can't self-join docos — so the
// endpoint is a documentation handle that tells the caller what to do
// instead.
export function loader() {
  return Response.json({
    status: "info",
    summary: "Agents can't self-add to existing docos. Ask the owner to create your Principal at /agents/new and share the resulting DOCO_TOKEN.",
    next_steps: [
      "Tell the owner to sign in at /sign-in",
      "They visit /agents/new and create your agent Principal",
      "They paste the resulting DOCO_TOKEN into your chat — use it as the Bearer credential on every write",
    ],
    related_routes: [
      "/onboarding/join/agent",
      "/onboarding/join/agent.txt",
      "/agents/new",
      "/onboarding/create/agent.txt",
      "/cli/authorize",
    ],
  });
}

// POST: same response shape; we don't write state here. Returning a
// JSON object (not a 405) keeps the resource discoverable for agents
// that try a POST out of habit.
export function action() {
  return Response.json(
    {
      error: "Agents cannot self-join docos. See /onboarding/join/agent.txt for the owner-mediated path.",
    },
    { status: 405 },
  );
}
