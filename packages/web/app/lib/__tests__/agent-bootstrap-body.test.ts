import { describe, expect, it } from "vitest";
import { buildAgentBootstrapBody } from "../agent-bootstrap-body";

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
        projectTokenGrant: { doco_id: "doco_x", role: "reader" },
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

  it("derives the canonical-instructions URL from the origin and embeds the prose", () => {
    const body = buildAgentBootstrapBody(base);
    expect(body.canonical_instructions_url).toBe("https://doco.to/protocol/canonical-instructions");
    expect(typeof body.canonical_instructions).toBe("string");
  });
});
