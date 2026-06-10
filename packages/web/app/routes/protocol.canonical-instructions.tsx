// GET /protocol/canonical-instructions — the three-invariant agent
// protocol every Doco-connected reply must follow.
//
// Served as text/markdown. Public; no auth. Replaces the MCP-resource
// delivery path during the period the MCP layer is removed.

import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";

export function loader() {
  return new Response(CANONICAL_INSTRUCTIONS, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}
