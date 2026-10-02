import { describe, expect, it } from "vitest";
import { buildAgentBootstrapBody } from "../agent-bootstrap-body";
import { agentInstructions } from "../agent-instructions";

const base = {
  origin: "https://doco.to",
  principal: null,
  oauthGrant: null,
  projectTokenGrant: null,
  docoPolicies: [],
  workspaceConstitutions: [],
};

describe("buildAgentBootstrapBody", () => {
  it("leads with the workspace constitution — before the doco policies, not after", () => {
    const keys = Object.keys(buildAgentBootstrapBody(base));
    expect(keys[0]).toBe("workspace_constitutions");
    expect(keys.indexOf("workspace_constitutions")).toBeLessThan(keys.indexOf("doco_policies"));
  });

  it("emits the SAME field order on the project-token path and the oauth path", () => {
    const tokenPath = Object.keys(
      buildAgentBootstrapBody({
        ...base,
        projectTokenGrant: { workspace_id: "workspace_x", role: "reader" },
      }),
    );
    const oauthPath = Object.keys(
      buildAgentBootstrapBody({
        ...base,
        principal: { username: "alice" },
        oauthGrant: { client_id: "doco_client_x" },
      }),
    );
    expect(tokenPath).toEqual(oauthPath);
  });

  // One agent-instructions template everywhere: the bootstrap carries the
  // block and points at /agents, which shows it, not a second protocol.
  it("carries the agent instructions and points at /agents", () => {
    const body = buildAgentBootstrapBody(base);
    expect(body.agent_instructions_url).toBe("https://doco.to/agents");
    expect(body.agent_instructions).toBe(agentInstructions("https://doco.to"));
    expect(body).not.toHaveProperty("canonical_instructions");
  });
});
