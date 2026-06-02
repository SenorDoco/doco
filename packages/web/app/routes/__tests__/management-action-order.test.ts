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

describe("management action order", () => {
  it("puts Doco app integrations before collaborators and policies before settings", () => {
    const source = routeSource("../$docoHandle._index.tsx");

    expectMarkerBefore(
      source,
      "to={`/${handle}/integrations`}",
      '<UsersLink level="doco" targetId={docoId} />',
    );
    expectMarkerBefore(source, "to={`/${handle}/policies`}", "to={`/${handle}/settings`}");
  });

  it("puts workspace app integrations before collaborators", () => {
    const source = routeSource("../workspaces.$workspaceHandle._index.tsx");

    expectMarkerBefore(
      source,
      "to={`/workspaces/${workspace.handle}/integrations`}",
      '<UsersLink level="workspace" targetId={workspace.id} />',
    );
  });
});
