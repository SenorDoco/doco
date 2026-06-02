import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  connectHrefFor,
  findIntegration,
  needsScopePrompt,
} from "../integrations-catalog";

const slack = findOrThrow("slack");
const github = findOrThrow("github");

function findOrThrow(id: string) {
  const found = INTEGRATION_CATALOG.find((i) => i.id === id);
  if (!found) throw new Error(`Catalog is missing the ${id} entry — test setup is broken.`);
  return found;
}

describe("integrations-catalog", () => {
  it("exposes Slack at account scope and GitHub at Doco scope", () => {
    expect(slack).toBeDefined();
    expect(slack.scope).toBe("account");
    expect(github).toBeDefined();
    expect(github.scope).toBe("doco");
  });

  it("findIntegration returns the matching definition", () => {
    expect(findIntegration("slack")).toEqual(slack);
    expect(findIntegration("github")).toEqual(github);
    expect(findIntegration("nope")).toBeUndefined();
  });

  describe("needsScopePrompt", () => {
    it("is false when the integration matches the page scope", () => {
      expect(needsScopePrompt({ integration: slack, pageScope: "account" })).toBe(false);
      expect(needsScopePrompt({ integration: github, pageScope: "doco" })).toBe(false);
    });

    it("is false for account-scope integrations regardless of page", () => {
      expect(needsScopePrompt({ integration: slack, pageScope: "workspace" })).toBe(false);
      expect(needsScopePrompt({ integration: slack, pageScope: "doco" })).toBe(false);
    });

    it("is true when an workspace/Doco integration is clicked from a higher scope", () => {
      expect(needsScopePrompt({ integration: github, pageScope: "account" })).toBe(true);
      expect(needsScopePrompt({ integration: github, pageScope: "workspace" })).toBe(true);
    });
  });

  describe("connectHrefFor", () => {
    it("links Slack directly to its install URL from any page", () => {
      expect(connectHrefFor({ integration: slack, pageScope: "account" })).toBe(
        "/integrations/slack/install",
      );
      expect(
        connectHrefFor({ integration: slack, pageScope: "workspace", workspaceHandle: "acme" }),
      ).toBe("/integrations/slack/install");
      expect(connectHrefFor({ integration: slack, pageScope: "doco", docoHandle: "test" })).toBe(
        "/integrations/slack/install",
      );
    });

    it("routes GitHub clicks from a Doco through the Doco-specific connection flow", () => {
      const href = connectHrefFor({
        integration: github,
        pageScope: "doco",
        docoHandle: "test",
        docoInstallUrl: "https://github.com/apps/doco/installations/new?state=docoid",
      });
      expect(href).toBe("/test/integrations/github");
    });

    it("routes GitHub clicks from the account page to a pick-doco prompt", () => {
      const href = connectHrefFor({ integration: github, pageScope: "account" });
      expect(href).toBe("/integrations?integration=github#pick-doco");
    });

    it("routes GitHub clicks from an workspace page to that workspace's pick-doco prompt", () => {
      const href = connectHrefFor({
        integration: github,
        pageScope: "workspace",
        workspaceHandle: "acme",
      });
      expect(href).toBe("/workspaces/acme/integrations?integration=github#pick-doco");
    });
  });
});
