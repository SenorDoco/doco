// GET /api/v1/whoami.json — who is this token/session, and what can it
// touch? Returns the caller's display name, principal kind, and the
// "levels of access" attached to the credential (scoped to the OAuth
// token's grants when a bearer is present). Agents call this right
// after authenticating to tell the user their Doco identity:
//
//   [🔮 Doco] Authenticated as @username. I've got the following
//   levels of access:
//     * <org/doco>: <role>
//
// Auth: requires a signed-in principal (cookie session or OAuth
// bearer). 401 when neither resolves.

import { loadAgentIdentity } from "~/lib/agent-identity.server";

export async function loader({ request }: { request: Request }) {
  const identity = await loadAgentIdentity(request);
  if (!identity) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  return Response.json(identity);
}
