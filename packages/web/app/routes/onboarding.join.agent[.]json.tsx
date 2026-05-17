// JSON-shaped sibling of /onboarding/join/agent. Joining a Doco is
// a single HTTP call when you have an invite, or a single
// ask-the-user when you don't.
export function loader() {
  return Response.json({
    status: "info",
    summary:
      "Redeem an invite URL (https://doco.to/invite/<code>) with one POST to /api/v1/invites/<code>/redeem.json. If you don't have an invite, ask the user — either the user signs in at <doco_url> to mint one, or asks an already-connected agent to POST /agent/<DOCO_KEY>/api/invites.json.",
    recipe: {
      redeem: "POST https://doco.to/api/v1/invites/<code>/redeem.json (no auth, empty body)",
      mint: "POST https://doco.to/agent/<DOCO_KEY>/api/invites.json (auth via existing key)",
      details: "https://doco.to/llms.txt",
    },
    next_steps: [
      "POST /api/v1/invites/<code>/redeem.json (no auth, empty body).",
      "Walk the response's `next_steps_for_agent` array top-to-bottom — it carries the ordered checklist (write DOCO_KEY to .env, write doco.md if missing, update AGENTS.md / CLAUDE.md, fetch the canonical, render user_message_block).",
      "Render the response's `user_message_block` verbatim to whoever pasted the invite — names the Doco, what files you wrote, and how they can claim their own access.",
    ],
    related_routes: [
      "/onboarding/join/agent.txt",
      "/onboarding/create/agent.txt",
      "/llms.txt",
      "/api/v1/docos.json",
      "/api/v1/invites/<code>/redeem.json",
    ],
  });
}

export function action() {
  return Response.json(
    {
      error:
        "No state to mutate here. Use POST /api/v1/invites/<code>/redeem.json to redeem an invite URL.",
    },
    { status: 405 },
  );
}
