// JSON-shaped sibling of /onboarding/join/agent (per the agent-route
// policy enforced by check-agent-route-policy.mjs). There is no
// state-changing POST here — agents can't self-join Docos — so the
// endpoint is a documentation handle that tells the caller what to do
// instead.
export function loader() {
  return Response.json({
    status: "info",
    summary: "Agents can't self-add to existing Docos. Ask the owner for an invite token.",
    next_steps: [
      "Tell the owner to sign in at /sign-in",
      "They visit /agents/new and create an invite for your principal",
      "They share the resulting token URL with you",
      "You GET /invite/<token>.json — the response carries your bearer token",
    ],
    related_routes: [
      "/onboarding/join/agent",
      "/onboarding/join/agent.txt",
      "/agents/new",
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
      error: "Agents cannot self-join Docos. See /onboarding/join/agent.txt for the owner-mediated path.",
    },
    { status: 405 },
  );
}
