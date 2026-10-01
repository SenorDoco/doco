import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type { CodeView } from "~/lib/codebase-read.server";
import type { GitHubIntegrationStatus, IntegrationStatus } from "~/lib/integration-status.server";
import type { ReaderTreeItem } from "~/lib/reader";
import { CodeReaderView } from "../code-views";

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

function render(view: CodeView, status: IntegrationStatus = { ...importing, state: "done" }) {
  const Stub = createRoutesStub([
    {
      path: "*",
      Component: () => createElement(CodeReaderView, { handle: "acme-codebase", view, status }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/acme-codebase/code"] }));
}

const item = (id: string, kind: ReaderTreeItem["kind"], files: number | null = null) => ({
  id,
  name: id.split("/").pop() ?? id,
  kind,
  icon: null,
  hasChildren: kind !== "file",
  files,
  pending: false,
  where: "",
});

const file = {
  repo: "acme/app",
  path: "src/billing/tax.ts",
  url: "https://github.com/acme/app/blob/HEAD/src/billing/tax.ts",
  size: 7200,
  omitted: null,
  syncedAt: "2026-09-30T10:00:00.000Z",
};

const noCode: CodeView = { view: "repos", repos: [], trail: [] };

describe("CodeReaderView, before any code is copied", () => {
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

  it("says GitHub refused the code, and what to accept in GitHub", () => {
    const html = render(noCode, { ...importing, state: "done", skipped: 14, refused: true });
    expect(html).toContain(
      "GitHub hasn&#x27;t given Doco&#x27;s GitHub App access to the code of 14 repositories yet. Accept the App&#x27;s request for Contents access in GitHub. The copy runs again once it&#x27;s accepted.",
    );
    expect(html).toMatch(/href="\/acme-codebase\/integrations\/github"[^>]*>Manage GitHub/);
  });
});

describe("CodeReaderView", () => {
  it("lists several repositories, each with its file count", () => {
    const html = render({
      view: "repos",
      repos: [item("acme/api", "repo", 1), item("acme/app", "repo", 785)],
      trail: [],
    });
    expect(html).toContain('href="/acme-codebase/code/acme/api"');
    expect(html).toContain('href="/acme-codebase/code/acme/app"');
    expect(html).toContain("785 files");
  });

  it("opens a folder on a grid of its entries above its README", () => {
    const html = render({
      view: "folder",
      repo: "acme/app",
      dir: "src",
      entries: [item("acme/app/src/billing", "dir", 2), item("acme/app/src/index.ts", "file")],
      more: 0,
      readme: { path: "src/README.md", markdown: "# Source\n\nWhere the code\nlives." },
      trail: ["acme/app", "acme/app/src"],
    });
    expect(html).toContain('href="/acme-codebase/code/acme/app/src/billing"');
    expect(html).toContain('href="/acme-codebase/code/acme/app/src/index.ts"');
    // The way up: the repository, then each folder.
    expect(html).toContain('href="/acme-codebase/code/acme/app"');
    expect(html).toContain("README.md");
    expect(html).toContain(">Source</h2>");
    expect(html).toContain("Where the code lives.");
    expect(html).toContain('href="https://github.com/acme/app/tree/HEAD/src"');
  });

  it("shows a file colored by token, numbered by line, each number linking to its line", () => {
    const html = render({
      view: "file",
      file,
      lines: [
        [["k", "export"], " ", ["k", "const"], " tax = ", ["n", "1"], ";"],
        ["<script>alert(1)</script>"],
        [],
      ],
      markdown: null,
      trail: ["acme/app", "acme/app/src", "acme/app/src/billing", "acme/app/src/billing/tax.ts"],
    });
    expect(html).toContain('<span class="tok-k">export</span>');
    expect(html).toContain('<span class="tok-n">1</span>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('id="L2"');
    expect(html).toContain('href="#L2"');
    expect(html).toContain("3 lines");
    expect(html).toContain("7.0 KB");
    expect(html).toContain('href="https://github.com/acme/app/blob/HEAD/src/billing/tax.ts"');
    expect(html).toContain('href="/acme-codebase/code/acme/app/src/billing"');
  });

  it("previews a Markdown file, with a switch to its raw lines", () => {
    const html = render({
      view: "file",
      file: { ...file, path: "docs/guide.md" },
      lines: [["# Guide"], ["See [setup](setup.md) and [src](../src/index.ts)."]],
      markdown: "# Guide\n\nSee [setup](setup.md) and [src](../src/index.ts).",
      trail: ["acme/app", "acme/app/docs", "acme/app/docs/guide.md"],
    });
    expect(html).toContain(">Guide</h2>");
    expect(html).toContain("Preview");
    expect(html).toContain("Raw");
    // Links between files stay in the reader.
    expect(html).toContain('href="/acme-codebase/code/acme/app/docs/setup.md"');
    expect(html).toContain('href="/acme-codebase/code/acme/app/src/index.ts"');
  });

  it("says why a file is kept by name only", () => {
    const html = render({
      view: "file",
      file: { ...file, omitted: "binary" },
      lines: [],
      markdown: null,
      trail: [],
    });
    expect(html).toContain("A binary file: the copy keeps its name only.");
  });

  it("groups search matches by file, each line linking to itself", () => {
    const html = render({
      view: "search",
      query: "tax",
      hits: [
        {
          type: "code_file",
          repo: "acme/app",
          path: "src/billing/invoice.ts",
          url: "https://github.com/acme/app/blob/HEAD/src/billing/invoice.ts",
          matches: [
            { line: 1, text: 'import { tax } from "./tax";' },
            { line: 4, text: "return tax(lines);" },
          ],
          matchCount: 5,
        },
        {
          type: "code_file",
          repo: "acme/app",
          path: "src/tax.md",
          url: "https://github.com/acme/app/blob/HEAD/src/tax.md",
          matches: [],
          matchCount: 0,
        },
      ],
      trail: [],
    });
    expect(html).toContain("5 matches");
    expect(html).toContain("in 2 files");
    expect(html).toContain('href="/acme-codebase/code/acme/app/src/billing/invoice.ts#L4"');
    expect(html).toContain("3 more matches in this file");
    expect(html).toContain("<mark>tax</mark>");
    expect(html).toContain("Matches by name");
    // A filter per file type among the results.
    expect(html).toContain(">.ts<");
    expect(html).toContain(">.md<");
  });

  it("says when nothing matches", () => {
    expect(render({ view: "search", query: "zzz", hits: [], trail: [] })).toContain(
      "No files match “zzz”.",
    );
  });
});
