import { describe, expect, it } from "vitest";
import { loader } from "../protocol.agent-oauth-recipe";

describe("/protocol/agent-oauth-recipe", () => {
  it("points hosted MCP setup to the Tokens/MCP 'Add MCP' tab instead of /connect", async () => {
    const response = loader({
      request: new Request("https://doco.test/protocol/agent-oauth-recipe"),
    });
    const body = await response.text();

    expect(body).toContain("Tokens/MCP");
    expect(body).toContain('"Add MCP" tab');
    expect(body).not.toContain("Add MCP manually");
    expect(body).toContain("https://doco.test/tokens");
    expect(body).not.toContain("https://doco.test/connect");
  });

  it("starts a project with its Workspace, then creates Docos inside it", async () => {
    const response = loader({
      request: new Request("https://doco.test/protocol/agent-oauth-recipe"),
    });
    const body = await response.text();

    const createWorkspace = body.indexOf("POST https://doco.test/api/v1/workspaces.json");
    const createDoco = body.indexOf("POST https://doco.test/api/v1/docos.json");
    expect(createWorkspace).toBeGreaterThan(-1);
    expect(createDoco).toBeGreaterThan(createWorkspace);
    expect(body).toContain("One project = one Workspace");
  });
});
