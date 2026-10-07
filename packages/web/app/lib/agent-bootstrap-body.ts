// The agent-bootstrap JSON body, shaped in ONE place so the hook-token path
// and the OAuth/cookie path can never drift in field set or ORDER.
//
// The workspace constitution leads: it's the governing charter for the workspace's work that an
// agent should read BEFORE the per-doco policies, so `workspace_constitutions`
// comes first, not last. Pure (no IO) so the ordering is unit-testable without
// a database.

import type { DocoPolicySet, WorkspaceConstitution } from "./agent-bootstrap.server";
import { AGENT_INSTRUCTIONS_PATH, agentInstructions } from "./agent-instructions";

export function buildAgentBootstrapBody<P, G, T>(input: {
  /** Request origin, e.g. `https://doco.to` — the host the agent instructions name. */
  origin: string;
  principal: P;
  oauthGrant: G;
  hookTokenGrant: T;
  docoPolicies: DocoPolicySet[];
  workspaceConstitutions: WorkspaceConstitution[];
}) {
  return {
    workspace_constitutions: input.workspaceConstitutions,
    principal: input.principal,
    agent_instructions_url: new URL(AGENT_INSTRUCTIONS_PATH, input.origin).toString(),
    agent_instructions: agentInstructions(input.origin),
    oauth_grant: input.oauthGrant,
    hook_token_grant: input.hookTokenGrant,
    doco_policies: input.docoPolicies,
  };
}
