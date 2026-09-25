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

  it("finds or creates the project's Workspace before creating any Doco", async () => {
    const body = await llmsTxt();
    const findWorkspace = body.indexOf("GET https://doco.test/api/v1/workspaces.json");
    const createWorkspace = body.indexOf("POST https://doco.test/api/v1/workspaces.json");
    const createDoco = body.indexOf("POST https://doco.test/api/v1/docos.json");
    expect(findWorkspace).toBeGreaterThan(-1);
    expect(createWorkspace).toBeGreaterThan(findWorkspace);
    expect(createDoco).toBeGreaterThan(createWorkspace);
    expect(body).toContain('"requested_id"');
    expect(body).toContain("https://doco.test/new-workspace");
  });

  it("lists every creatable template so the agent can pick the project's Docos", async () => {
    const body = await llmsTxt();
    for (const template of DOCO_TEMPLATES) {
      expect(body).toContain(`- ${template.handle} — ${template.label}`);
    }
  });
});
