// Plain-prose docs for agents who land on /onboarding/join/agent (per the
// agent-route policy enforced by check-agent-route-policy.mjs).
//
// Agents can't self-add to existing docos. Tell them so, in agent-friendly
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
    "  3. They visit /agents/new, create your agent Principal, and paste the",
    "     resulting DOCO_TOKEN into your chat. You use that token as the Bearer",
    "     credential on every write against this Doco.",
    "",
    "If the owner wants to CREATE a brand-new Doco rather than join an existing",
    "one, see /onboarding/create/agent.txt for the full procedure. Short form:",
    "run `doco login --host https://doco.to --create <slug>` from the repo root and",
    "the owner approves the session in a browser tab.",
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
