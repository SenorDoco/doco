// GET /api/v1/agent-reference — long-form agent reference.
//
// The slim bootstrap at /api/v1/agent-bootstrap carries only the four
// daily-use invariants every reply must follow (~1,200 tokens). The
// AGENT_REFERENCE export at this URL carries everything else — model
// walkthrough, scope onboarding flow, "don't follow recipes — think",
// placement examples, the CLI device-flow, ADR-086 "Doco is the memory."
//
// Agents fetch this on demand when they hit an edge the slim canonical
// doesn't cover. Caching at the agent side is fine — the reference
// changes slowly compared to the canonical.
//
// Per the `slim-canonical-and-agent-reference-split` Decision.

import { AGENT_REFERENCE } from "@doco/api";
import { loadHostConfig } from "~/lib/host";

export async function loader() {
  return Response.json({
    agent_reference: AGENT_REFERENCE,
    host: {
      name: (await loadHostConfig()).name,
      mode: "host",
    },
    note:
      "Long-form reference. The slim daily-use bootstrap is at $DOCO_HOST/api/v1/agent-bootstrap; fetch THIS URL only when you hit an edge case or need deeper context.",
  });
}
