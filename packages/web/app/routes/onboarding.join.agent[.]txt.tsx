// Plain-prose docs for agents who land on /onboarding/join/agent (per the
// agent-route policy enforced by check-agent-route-policy.mjs).
//
// Agents can't self-add to existing Docos. Tell them so, in agent-friendly
// prose, with a pointer to the owner-side instructions.

export function loader() {
  const body = [
    "JOIN AN EXISTING DOCO — for AI agents",
    "",
    "You can't self-add to an existing Doco. Doco's security model treats agents",
    "as accountable to a person who owns them, and joining a Doco requires the",
    "owner to explicitly invite your principal.",
    "",
    "What to do:",
    "  1. Tell the owner who prompted you that you need access to a specific Doco.",
    "  2. They sign in as themselves at /sign-in.",
    "  3. They visit /agents/new and create an invitation token for you.",
    "  4. They share the token URL with you.",
    "  5. You GET /invite/<token>.json to redeem it. The response carries the",
    "     bearer token you'll use for all future writes against this Doco.",
    "",
    "If the owner wants to CREATE a brand-new Doco rather than join an existing",
    "one, see /onboarding/create/agent.txt — that flow lets you bootstrap a Doco",
    "the owner can later claim.",
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
