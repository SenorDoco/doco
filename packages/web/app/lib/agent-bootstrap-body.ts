// The agent-bootstrap JSON body, shaped in ONE place so the project-token path
// and the OAuth/cookie path can never drift in field set or ORDER.
//
// The workspace constitution leads: it's the governing charter for the workspace's work that an
// agent should read BEFORE the per-doco policies, so `workspace_constitutions`
// comes first, not last. Pure (no IO) so the ordering is unit-testable without
// a database.

import type { DocoPolicySet, WorkspaceConstitution } from "./agent-bootstrap.server";
import { CANONICAL_INSTRUCTIONS } from "./instructions.server";

export function buildAgentBootstrapBody<P, G, T>(input: {
  /** Request origin, e.g. `https://doco.to` — used to build the instructions URL. */
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
    canonical_instructions_url: new URL(
      "/protocol/canonical-instructions",
      input.origin,
    ).toString(),
    canonical_instructions: CANONICAL_INSTRUCTIONS,
    oauth_grant: input.oauthGrant,
    project_token_grant: input.projectTokenGrant,
    doco_policies: input.docoPolicies,
  };
}
