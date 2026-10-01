// A source of knowledge joins a workspace's onboarding by its catalog entry
// (with the template of the Doco it fills) and a connector that knows how to
// approve its copy. Neither works without the other.
import { describe, expect, it } from "vitest";
import { BRAND_ICONS } from "~/components/brand-icons";
import { findDocoTemplateMeta } from "../doco-templates-meta";
import { KNOWLEDGE_SOURCE_INTEGRATIONS, sourceIntegrationFor } from "../integrations-catalog";
import { KNOWLEDGE_SOURCE_CONNECTORS, sourceConnected } from "../knowledge-sources.server";

describe("sources of knowledge", () => {
  it("offers Slack and Notion during onboarding", () => {
    expect(KNOWLEDGE_SOURCE_INTEGRATIONS.map((i) => i.id)).toEqual(["slack", "notion"]);
  });

  it("gives every source a connector, a brand icon and a Doco template", () => {
    for (const integration of KNOWLEDGE_SOURCE_INTEGRATIONS) {
      expect(KNOWLEDGE_SOURCE_CONNECTORS[integration.id], integration.id).toBeDefined();
      expect(BRAND_ICONS[integration.id], integration.id).toBeDefined();
      expect(findDocoTemplateMeta(integration.template), integration.id).toBeDefined();
    }
    expect(Object.keys(KNOWLEDGE_SOURCE_CONNECTORS).sort()).toEqual(
      KNOWLEDGE_SOURCE_INTEGRATIONS.map((i) => i.id).sort(),
    );
  });

  it("finds the source a Doco copies from by its template", () => {
    expect(sourceIntegrationFor("slack")).toBe("slack");
    expect(sourceIntegrationFor("notion")).toBe("notion");
    expect(sourceIntegrationFor("codebase")).toBe("github");
    expect(sourceIntegrationFor("glossary")).toBeNull();
    expect(sourceIntegrationFor(undefined)).toBeNull();
  });

  it("reads a source as connected once its Doco copies from it", async () => {
    const asked: unknown[][] = [];
    const client = (connected: boolean) => ({
      query: async <T>(sql: string, params?: unknown[]) => {
        asked.push([sql, params]);
        return { rows: [{ connected }] as T[] };
      },
    });
    expect(await sourceConnected(client(true), "slack", "doco_1")).toBe(true);
    expect(await sourceConnected(client(false), "notion", "doco_2")).toBe(false);
    expect(await sourceConnected(client(true), "nope", "doco_3")).toBe(false);
    expect(asked.map(([, params]) => params)).toEqual([["doco_1"], ["doco_2"]]);
  });
});
