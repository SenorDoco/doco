import { describe, expect, it } from "vitest";
import { firstPersonLines } from "~/lib/__tests__/first-person";
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

  it("starts a project from an existing Workspace and never has the agent create one", async () => {
    const response = loader({
      request: new Request("https://doco.test/protocol/agent-oauth-recipe"),
    });
    const body = await response.text();

    const findWorkspace = body.indexOf("GET https://doco.test/api/v1/workspaces.json");
    const createDoco = body.indexOf("POST https://doco.test/api/v1/docos.json");
    expect(findWorkspace).toBeGreaterThan(-1);
    expect(createDoco).toBeGreaterThan(findWorkspace);
    expect(body).toContain("One project = one Workspace");
    expect(body).toContain("agents never create Workspaces");
    expect(body).toContain("https://doco.test/new-workspace");
    expect(body).not.toContain("POST https://doco.test/api/v1/workspaces.json");
  });
});

describe("/protocol/agent-oauth-recipe voice", () => {
  it("never puts first-person lines in an agent's mouth", async () => {
    const response = loader({
      request: new Request("https://doco.test/protocol/agent-oauth-recipe"),
    });
    const body = await response.text();
    expect(firstPersonLines(body)).toEqual([]);
  });
});
