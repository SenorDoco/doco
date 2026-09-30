// The agent-bootstrap JSON body, shaped in ONE place so the project-token path
// and the OAuth/cookie path can never drift in field set or ORDER.
//
// The workspace constitution leads: it's the governing charter for the workspace's work that an
// agent should read BEFORE the per-doco policies, so `workspace_constitutions`
// comes first, not last. Pure (no IO) so the ordering is unit-testable without
// a database.

import type { DocoPolicySet, WorkspaceConstitution } from "./agent-bootstrap.server";
import { agentInstructions } from "./agent-instructions";

export function buildAgentBootstrapBody<P, G, T>(input: {
  /** Request origin, e.g. `https://doco.to` — the host the agent instructions name. */
  origin: string;
  principal: P;
  oauthGrant: G;
  projectTokenGrant: T;
  docoPolicies: DocoPolicySet[];
  workspaceConstitutions: WorkspaceConstitution[];
}) {
  return {
    workspace_constitutions: input.workspaceConstitutions,
    principal: input.principal,
    agent_instructions_url: new URL("/", input.origin).toString(),
    agent_instructions: agentInstructions(input.origin),
    oauth_grant: input.oauthGrant,
    project_token_grant: input.projectTokenGrant,
    doco_policies: input.docoPolicies,
  };
}
