import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { GitHubImportStarted } from "../github-repo-picker";

function render(props: Parameters<typeof GitHubImportStarted>[0]): string {
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(GitHubImportStarted, props) }],
    { initialEntries: ["/integrations/github"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

const DOCOS = [
  { handle: "acme-pull-requests", items: "pull requests" },
  { handle: "acme-codebase", items: "files" },
];

describe("GitHubImportStarted", () => {
  it("leads back to the workspace, whose setup goes on from there", () => {
    const html = render({ workspaceHandle: "acme", count: 3, orgs: [], docos: DOCOS });
    expect(html).toContain('href="/workspaces/acme"');
    expect(html).toContain("Back to acme");
    expect(html).toContain('href="/acme-pull-requests"');
    expect(html).toContain('href="/acme-codebase"');
  });

  it("promises later repositories only for an organization picked whole", () => {
    const picked = render({ workspaceHandle: "acme", count: 3, orgs: [], docos: DOCOS });
    expect(picked).not.toContain("later");
    const whole = render({ workspaceHandle: "acme", count: 3, orgs: ["acme-inc"], docos: DOCOS });
    expect(whole).toContain("Repositories added to acme-inc later come in too.");
  });
});
