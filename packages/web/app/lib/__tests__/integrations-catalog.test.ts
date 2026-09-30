import { describe, expect, it } from "vitest";
import { INTEGRATION_CATALOG, connectHrefFor, findIntegration } from "../integrations-catalog";

const slack = findOrThrow("slack");
const github = findOrThrow("github");
const notion = findOrThrow("notion");

function findOrThrow(id: string) {
  const found = INTEGRATION_CATALOG.find((i) => i.id === id);
  if (!found) throw new Error(`Catalog is missing the ${id} entry — test setup is broken.`);
  return found;
}

describe("integrations-catalog", () => {
  it("exposes Slack at workspace scope and GitHub and Notion at Doco scope", () => {
    expect(slack).toBeDefined();
    expect(slack.scope).toBe("workspace");
    expect(github).toBeDefined();
    expect(github.scope).toBe("doco");
    expect(notion.scope).toBe("doco");
  });

  it("routes Notion clicks from a Doco to that Doco's mirror page", () => {
    expect(connectHrefFor({ integration: notion, docoHandle: "test" })).toBe(
      "/test/integrations/notion",
    );
    expect(connectHrefFor({ integration: notion })).toBe("/integrations?integration=notion");
  });

  it("findIntegration returns the matching definition", () => {
    expect(findIntegration("slack")).toEqual(slack);
    expect(findIntegration("github")).toEqual(github);
    expect(findIntegration("nope")).toBeUndefined();
  });

  describe("connectHrefFor", () => {
    it("links Slack directly to its install URL from any page", () => {
      expect(connectHrefFor({ integration: slack })).toBe("/integrations/slack/install");
      expect(connectHrefFor({ integration: slack, workspaceHandle: "acme" })).toBe(
        "/integrations/slack/install",
      );
      expect(connectHrefFor({ integration: slack, docoHandle: "test" })).toBe(
        "/integrations/slack/install",
      );
    });

    it("routes GitHub clicks from a Doco through the Doco-specific connection flow", () => {
      const href = connectHrefFor({ integration: github, docoHandle: "test" });
      expect(href).toBe("/test/integrations/github");
    });

    it("routes GitHub clicks from the account page to the GitHub setup", () => {
      const href = connectHrefFor({ integration: github });
      expect(href).toBe("/integrations/github");
    });

    it("routes GitHub clicks from a workspace page to the GitHub setup for that workspace", () => {
      const href = connectHrefFor({ integration: github, workspaceHandle: "acme" });
      expect(href).toBe("/integrations/github?workspace=acme");
    });
  });
});
