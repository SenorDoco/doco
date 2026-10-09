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
const base = { workspaceHandle: "acme", count: 3, orgs: [], docos: DOCOS, issueRepos: null };
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("GitHubImportStarted", () => {
  it("goes on with one Continue to the workspace, whose setup takes the next step", () => {
    const html = render(base);
    const buttons = html.match(/<a [^>]*neu-button[^>]*>[^<]*<\/a>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('href="/workspaces/acme"');
    expect(buttons[0]).toContain(">Continue<");
    // Each Doco the import fills is still a link, in the sentence naming it.
    expect(html).toContain('href="/acme-pull-requests"');
    expect(html).toContain('href="/acme-codebase"');
  });

  it("promises later repositories only for an organization picked whole", () => {
    const picked = render(base);
    expect(picked).not.toContain("later");
    const whole = render({ ...base, orgs: ["acme-inc"] });
    expect(whole).toContain("Repositories added to acme-inc later come in too.");
  });

  it("says in its title that the import runs in the background, with no spinner", () => {
    const html = render(base);
    expect(html).toContain(">Import started in the background</h1>");
    expect(html).not.toContain("animate-spin");
    expect(text(html)).toContain(
      "Importing pull requests into acme-pull-requests and files into acme-codebase from 3 repositories. You can keep working;",
    );
  });

  it("says when issues come from only some of the repositories, or none", () => {
    const issues = [...DOCOS, { handle: "acme-github-issues", items: "issues" }];
    expect(text(render({ ...base, docos: issues, issueRepos: 3 }))).not.toContain("GitHub issues");
    expect(text(render({ ...base, docos: issues, issueRepos: 1 }))).toContain(
      "Only 1 of them uses GitHub issues, so issues come from that one.",
    );
    expect(text(render({ ...base, docos: issues, issueRepos: 2 }))).toContain(
      "Only 2 of them use GitHub issues, so issues come from those.",
    );
    expect(text(render({ ...base, issueRepos: 0 }))).toContain(
      "None of them use GitHub issues, so no issues come over.",
    );
  });

  it("says there is nothing to import when only issues were chosen and no repository uses them", () => {
    const html = render({ ...base, docos: [], issueRepos: 0 });
    expect(html).toContain(">Nothing to import</h1>");
    expect(text(html)).toContain("None of the 3 repositories you picked use GitHub issues.");
    expect(html).toContain('href="/workspaces/acme"');
  });
});
