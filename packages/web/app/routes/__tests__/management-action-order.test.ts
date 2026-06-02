import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function routeSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function expectMarkerBefore(source: string, earlier: string, later: string): void {
  const earlierIndex = source.indexOf(earlier);
  const laterIndex = source.indexOf(later);

  expect(earlierIndex, `Expected to find marker: ${earlier}`).toBeGreaterThanOrEqual(0);
  expect(laterIndex, `Expected to find marker: ${later}`).toBeGreaterThanOrEqual(0);
  expect(earlierIndex).toBeLessThan(laterIndex);
}

describe("management actions", () => {
  it("leaves only policies and settings on the Doco header, in that order", () => {
    const source = routeSource("../$docoHandle._index.tsx");

    // App integrations, collaborators, and tokens/MCP buttons were removed.
    expect(source).not.toContain("to={`/${handle}/integrations`}");
    expect(source).not.toContain('<UsersLink level="doco" targetId={docoId} />');
    expect(source).not.toContain("<ApiKeysLink />");

    // Policies and settings remain, policies before settings.
    expectMarkerBefore(source, "to={`/${handle}/policies`}", "to={`/${handle}/settings`}");
  });

  it("leaves only settings on the workspace header", () => {
    const source = routeSource("../workspaces.$workspaceHandle._index.tsx");

    // App integrations, collaborators, and tokens/MCP buttons were removed.
    expect(source).not.toContain("to={`/workspaces/${workspace.handle}/integrations`}");
    expect(source).not.toContain('<UsersLink level="workspace" targetId={workspace.id} />');
    expect(source).not.toContain("<ApiKeysLink />");

    // Settings remains.
    expect(source).toContain("to={`/workspaces/${workspace.handle}/settings`}");
  });
});
