// Plain-prose docs for agents who land on /onboarding/join/agent.
//
// The join-vs-create distinction is a project-owner choice in the
// browser, not an agent-side fork: the same /api/v1/agent-link/{start,
// poll} recipe works for both. This page tells the agent so, and points
// at the full recipe.
export function loader() {
  const body = [
    "JOIN AN EXISTING DOCO — for AI agents",
    "",
    "Same recipe as creating a new Doco — the project owner picks",
    "join-vs-create in the browser when they click Authorize. There",
    "is no separate join endpoint for agents to call.",
    "",
    "Quick reference:",
    "",
    "  1. GET https://doco.to/api/v1/agent-link/start?agent_name=<your-runtime>&hostname=<host>",
    "     (no auth, plain GET — no body, no state-mutation signal).",
    "     Response: { state_nonce, authorize_url, poll_url, interval_seconds }",
    "",
    "  2. Open <authorize_url> in their browser yourself — don't make",
    "     them copy-paste. Try `open` (macOS), `xdg-open` (Linux), or",
    "     `start` (Windows); fall back to printing the URL only if",
    "     none exist. The page lists Docos they already own — they",
    "     pick one (join path) OR enter a new slug below (create",
    "     path), then click Authorize.",
    "",
    "  3. Poll <poll_url> every interval_seconds (it's already a GET URL",
    "     with the state_nonce baked in). When the response carries",
    "     access_url, write DOCO_URL=<access_url> into ./.env and you're",
    "     connected.",
    "",
    "Full recipe with all edge cases:",
    "  https://doco.to/onboarding/create/agent.txt",
    "",
    "If the project owner has NO existing Docos, the authorize page only",
    "shows the create option — no choice to make. The agent's HTTP",
    "calls are identical either way.",
    "",
    "If the project owner DENIES the prompt in the browser, the poll",
    "response returns { status: \"denied\" }. Don't loop — stop and",
    "ask what they want to do.",
  ].join("\n");
  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
