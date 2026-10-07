// The messages an invite hands over. The person's goes in the invite dialog
// and in the invite APIs' responses; the agent's (an OAuth onboarding text that
// doesn't use the invite link) only in a Doco's invite API response.

/**
 * What a person receives: opening the invite URL in a signed-in browser adds
 * them to the workspace or Doco the invite grants.
 */
export function buildHumanInvitePrompt(inviteUrl: string): string {
  return [
    "Let's share knowledge on Doco. Open this URL and accept the invite:",
    "",
    inviteUrl,
  ].join("\n");
}

/**
 * Build the prompt to paste into an AI agent. Points the agent at
 * the OAuth recipe and names the per-Doco URL + Device-Flow approval
 * page so the agent can drive auth itself.
 */
export function buildAgentInvitePrompt(args: {
  docoUrl: string;
  recipeUrl: string;
  deviceUrl: string;
}): string {
  return [
    `Let's collaborate with Doco on this project. The doco is at ${args.docoUrl}.`,
    "",
    `To get programmatic access, follow the OAuth recipe at ${args.recipeUrl}. If you can bind a local TCP port and open a browser, use Recipe A (localhost-loopback). If you can't (chat-only / sandboxed runtimes), use Recipe B (RFC 8628 Device Authorization Grant) — show the short code it returns; the approval happens at ${args.deviceUrl}.`,
    "",
    `At the approve screen the doco owner names you and chooses your doco role. Either way you end up with a Bearer token you can use against ${args.docoUrl}.`,
  ].join("\n");
}
