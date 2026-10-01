import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type { CodePerspectiveData } from "~/lib/codebase-read.server";
import type { GitHubIntegrationStatus, IntegrationStatus } from "~/lib/integration-status.server";
import { CodePerspective } from "../code-perspective";

const base: CodePerspectiveData = {
  repos: [
    { repo: "acme/api", files: 1 },
    { repo: "acme/app", files: 3 },
  ],
  repo: "acme/app",
  dir: "src/billing",
  entries: [
    { name: "rules", path: "src/billing/rules", kind: "dir" },
    { name: "tax.ts", path: "src/billing/tax.ts", kind: "file" },
  ],
  file: {
    repo: "acme/app",
    path: "src/billing/tax.ts",
    url: "https://github.com/acme/app/blob/HEAD/src/billing/tax.ts",
    size: 40,
    omitted: null,
    content: "export const tax = 1;\n<script>alert(1)</script>",
    syncedAt: "2026-09-30T10:00:00.000Z",
  },
  query: "",
  hits: [],
};

function render(data: CodePerspectiveData, source?: IntegrationStatus): string {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => createElement(CodePerspective, { data, handle: "acme-codebase", source }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub));
}

const noCode = { ...base, repos: [], repo: null, entries: [], file: null };
const importing: GitHubIntegrationStatus = {
  integration: "github",
  item: "file",
  items: "files",
  latestAt: null,
  state: "importing",
  reposDone: 0,
  repos: 2,
  skipped: 0,
  refused: false,
  permission: "Contents",
};

describe("CodePerspective", () => {
  it("says no code comes in until repositories are picked, and leads there", () => {
    const html = render(noCode, { integration: "github", state: "unconnected" });
    expect(html).toContain("No repositories are connected, so no code is coming in yet.");
    expect(html).toMatch(/href="\/acme-codebase\/integrations\/github"[^>]*>Pick repositories/);
  });

  it("shows the copy under way while the first files are on their way", () => {
    const html = render(noCode, importing);
    expect(html).toContain("Copying the code of 2 repositories from GitHub.");
    expect(html).toContain("Files appear here as they are copied.");
    expect(html).not.toContain("Pick repositories");
  });

  it("says when a finished or stalled copy brought no files", () => {
    expect(render(noCode, { ...importing, state: "done" })).toContain(
      "No files came from the connected repositories.",
    );
    expect(render(noCode, { ...importing, state: "stalled" })).toContain(
      "Copying the code stalled.",
    );
  });

  it("says GitHub refused the code, and what to give Doco's GitHub App", () => {
    const html = render(noCode, { ...importing, state: "done", skipped: 14, refused: true });
    expect(html).toContain(
      "GitHub doesn&#x27;t let Doco&#x27;s GitHub App read the code of 14 repositories: give the App Contents read access in GitHub. The copy runs again once it&#x27;s accepted.",
    );
    expect(html).toMatch(/href="\/acme-codebase\/integrations\/github"[^>]*>Manage GitHub/);
  });

  it("lists the folder as links that keep the Code perspective open", () => {
    const html = render(base);
    expect(html).toContain(
      'href="/?perspective=code&amp;code_repo=acme%2Fapp&amp;code_path=src%2Fbilling%2Frules"',
    );
    expect(html).toContain('href="/?perspective=code&amp;code_repo=acme%2Fapi"');
    // The way up, one folder at a time.
    expect(html).toContain('href="/?perspective=code&amp;code_repo=acme%2Fapp&amp;code_path=src"');
  });

  it("shows the open file as text, numbered by line, never as markup", () => {
    const html = render(base);
    expect(html).toContain("export const tax = 1;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('href="https://github.com/acme/app/blob/HEAD/src/billing/tax.ts"');
    expect(html).toContain('id="L2"');
  });

  it("says why a file is kept by name only", () => {
    if (!base.file) throw new Error("the fixture opens a file");
    const html = render({ ...base, file: { ...base.file, omitted: "binary", content: "" } });
    expect(html).toContain("binary");
  });

  it("lists search hits linking to the line", () => {
    const html = render({
      ...base,
      file: null,
      query: "tax",
      hits: [
        {
          type: "code_file",
          repo: "acme/app",
          path: "src/billing/tax.ts",
          url: "https://github.com/acme/app/blob/HEAD/src/billing/tax.ts",
          snippet: "export const tax = 1;",
          line: 1,
        },
      ],
    });
    expect(html).toContain(
      'href="/?perspective=code&amp;code_repo=acme%2Fapp&amp;code_path=src%2Fbilling%2Ftax.ts#L1"',
    );
    expect(html).toContain("export const tax = 1;");
  });
});
