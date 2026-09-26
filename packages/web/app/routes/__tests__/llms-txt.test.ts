import { describe, expect, it } from "vitest";
import { DOCO_TEMPLATES } from "~/lib/doco-templates-meta";
import { loader } from "../llms[.]txt";

async function llmsTxt(): Promise<string> {
  const response = loader({ request: new Request("https://doco.test/llms.txt") });
  return await response.text();
}

describe("/llms.txt", () => {
  // An agent told "use Doco for <project>" followed this page, found only a
  // "create a Doco" recipe, and asked the user to make a lone Doco named after
  // the project. A project is a Workspace; its Docos are the kinds of knowledge
  // inside it. The page must teach that before any create recipe.
  it("maps a project to a Workspace, not to a Doco", async () => {
    const body = await llmsTxt();
    expect(body).toContain("One project = one Workspace");
    expect(body).toMatch(/a Doco never stands in for the project/i);
  });

  // Agents never create Workspaces: people do, and agents get access to all
  // of a user's workspaces, one workspace, or a subset of its Docos. The page
  // must send the agent to the user for the Workspace, never to a create call.
  it("finds the project's Workspace, has the user create a missing one, then creates Docos", async () => {
    const body = await llmsTxt();
    const findWorkspace = body.indexOf("GET https://doco.test/api/v1/workspaces.json");
    const askUser = body.indexOf("Ask the user to create the Workspace");
    const createDoco = body.indexOf("POST https://doco.test/api/v1/docos.json");
    expect(findWorkspace).toBeGreaterThan(-1);
    expect(askUser).toBeGreaterThan(findWorkspace);
    expect(createDoco).toBeGreaterThan(askUser);
    expect(body).toContain("https://doco.test/new-workspace");
    expect(body).not.toContain("POST https://doco.test/api/v1/workspaces.json");
    expect(body).not.toContain('"requested_id"');
  });

  it("names the three access levels a user can grant", async () => {
    const body = await llmsTxt();
    expect(body).toContain("all of their Workspaces");
    expect(body).toContain("one Workspace");
    expect(body).toContain("a subset of Docos");
  });

  it("lists every creatable template so the agent can pick the project's Docos", async () => {
    const body = await llmsTxt();
    for (const template of DOCO_TEMPLATES) {
      expect(body).toContain(`- ${template.handle} — ${template.label}`);
    }
  });
});
