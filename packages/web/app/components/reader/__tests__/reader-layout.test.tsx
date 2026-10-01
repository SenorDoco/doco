import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type {
  GitHubIntegrationStatus,
  IntegrationStatus,
  NotionIntegrationStatus,
} from "~/lib/integration-status.server";
import type { ReaderListing, ReaderTreeItem } from "~/lib/reader";
import { ReaderLayout, type ReaderShell } from "../reader-layout";

const NOW = new Date("2026-09-30T10:05:00.000Z");

const github: GitHubIntegrationStatus = {
  integration: "github",
  item: "file",
  items: "files",
  latestAt: "2026-09-30T10:00:00.000Z",
  state: "done",
  reposDone: 2,
  repos: 2,
  skipped: 0,
  refused: false,
  permission: "Contents",
};

const notion: NotionIntegrationStatus = {
  integration: "notion",
  workspaceName: "Acme",
  latestAt: "2026-09-30T09:00:00.000Z",
  state: "done",
  needsReauth: false,
  pagesDone: 1284,
  pages: 1284,
  listingCapped: false,
};

const item = (id: string, kind: ReaderTreeItem["kind"], extra: Partial<ReaderTreeItem> = {}) => ({
  id,
  name: id.split("/").pop() ?? id,
  kind,
  icon: null,
  hasChildren: kind === "repo" || kind === "dir",
  files: null,
  pending: false,
  where: "",
  ...extra,
});

const codeTree: Record<string, ReaderListing> = {
  "": {
    items: [
      item("acme/api", "repo", { name: "acme/api", files: 1 }),
      item("acme/app", "repo", { name: "acme/app", files: 784 }),
    ],
    more: 0,
  },
  "acme/app": {
    items: [item("acme/app/src", "dir", { files: 700 }), item("acme/app/README.md", "file")],
    more: 3,
  },
};

const codeShell: ReaderShell = {
  handle: "acme-codebase",
  reader: "code",
  template: "codebase",
  ownerSlug: "acme",
  ownerIsWorkspace: true,
  visibility: "private",
  goal: "",
  canAdmin: true,
  status: github,
  tree: codeTree,
  activity: {
    byDay: { writes: { "2026-09-30": 4 }, queries: {} },
    items: [
      {
        event_id: "ev_1",
        id: "decision_1",
        entity_type: "decision",
        summary: "Keep the API in its own repository",
        at: "2026-09-30T10:00:00.000Z",
        op: "entity.create",
        lifecycle: "active",
        before: null,
        after: null,
      },
    ],
    topContributors: [
      {
        userId: "user_ana",
        username: "ana",
        via: "Claude Code",
        count: 1,
        lastAt: "2026-09-30T10:00:00.000Z",
      },
    ],
    topQueryers: [],
  },
};

function render(
  shell: ReaderShell,
  opts: { trail?: string[]; query?: string; url?: string; status?: IntegrationStatus } = {},
): string {
  const Stub = createRoutesStub([
    {
      path: "*",
      Component: () => (
        <ReaderLayout
          shell={opts.status ? { ...shell, status: opts.status } : shell}
          trail={opts.trail ?? []}
          query={opts.query ?? ""}
          now={NOW}
        >
          <p>the open file</p>
        </ReaderLayout>
      ),
    },
  ]);
  return renderToStaticMarkup(
    createElement(Stub, { initialEntries: [opts.url ?? `/${shell.handle}/${shell.reader}`] }),
  );
}

describe("ReaderLayout header", () => {
  it("names the Doco and its kind, with one status line for the copy", () => {
    const html = render(codeShell);
    expect(html).toContain("acme-codebase");
    expect(html).toContain("GitHub codebase");
    expect(html).toContain("Live");
    expect(html).toContain("2 repositories · 785 files");
    expect(html).toContain("Latest file update 5m ago");
    expect(html).toMatch(/href="\/acme-codebase\/integrations\/github"[^>]*>Manage GitHub/);
    expect(html).toMatch(/href="\/acme-codebase\/settings"[^>]*>Settings/);
    expect(html).toContain('href="/workspaces/acme"');
  });

  it("says how far an import under way has got", () => {
    const html = render(codeShell, {
      status: { ...github, state: "importing", reposDone: 1 },
    });
    expect(html).toContain("Importing files: 1 of 2 repos");
  });

  it("leads a Doco nobody connected to its connection, and offers no Settings to non-admins", () => {
    const html = render(
      { ...codeShell, canAdmin: false, tree: { "": { items: [], more: 0 } } },
      { status: { integration: "github", state: "unconnected" } },
    );
    expect(html).toContain("Not connected");
    expect(html).toMatch(/href="\/acme-codebase\/integrations\/github"[^>]*>Pick repositories/);
    expect(html).not.toContain("/acme-codebase/settings");
  });

  it("counts a Notion copy in pages, under the workspace's name", () => {
    const html = render({
      ...codeShell,
      handle: "acme-notion",
      reader: "pages",
      template: "notion",
      status: notion,
      tree: null,
    });
    expect(html).toContain("Notion workspace");
    expect(html).toContain("Acme · 1,284 pages");
    expect(html).toMatch(/href="\/acme-notion\/integrations\/notion"[^>]*>Manage Notion/);
    expect(html).toContain('placeholder="Find a page or search every page"');
    expect(html).not.toContain("Go to page");
    expect(html).toContain('href="/acme-notion/pages"');
    // No tree: Notion's teamspaces and sidebar aren't in what its API shares,
    // so the copy can't be laid out the way Notion shows it.
    expect(html).not.toContain('aria-label="Files"');
    expect(html).not.toContain('aria-label="Pages"');
    expect(html).not.toContain("Show the pages");
    expect(html).toContain('aria-label="Doco activity"');
    expect(html).toContain("the open file");
  });
});

describe("ReaderLayout search and tree", () => {
  it("has one search, from where the reader is, keeping the open file to come back to", () => {
    const html = render(codeShell, { url: "/acme-codebase/code/acme/app/README.md" });
    expect(html).toContain('action="/acme-codebase/code/acme/app/README.md"');
    expect(html).toContain('name="q"');
    expect(html).toContain('placeholder="Find a file or search the code"');
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).not.toContain("Close search");
  });

  it("offers a way out of a search", () => {
    const html = render(codeShell, {
      url: "/acme-codebase/code/acme/app/README.md?q=tax",
      query: "tax",
    });
    expect(html).toContain('value="tax"');
    expect(html).toMatch(/href="\/acme-codebase\/code\/acme\/app\/README.md"[^>]*>Close search/);
  });

  it("lists the tree, open along the trail, marking the open item", () => {
    const html = render(codeShell, { trail: ["acme/app", "acme/app/README.md"] });
    expect(html).not.toContain("Go to file");
    expect(html).toContain('href="/acme-codebase/code/acme/api"');
    expect(html).toContain('href="/acme-codebase/code/acme/app/src"');
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/acme-codebase\/code\/acme\/app\/README.md"|href="\/acme-codebase\/code\/acme\/app\/README.md"[^>]*aria-current="page"/,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("3 more");
    expect(html).toContain("the open file");
  });
});

// Like every other Doco, the reader shows the Doco's activity beside whatever
// is open: the Activity chart, who wrote and queried most, and the latest
// writes.
describe("ReaderLayout activity column", () => {
  it("shows the Doco's activity beside an open file", () => {
    const html = render(codeShell, { url: "/acme-codebase/code/acme/app/README.md" });
    expect(html).toContain("the open file");
    expect(html).toContain('aria-label="Doco activity"');
    expect(html).toContain(">Activity<");
    expect(html).toContain(">Top contributors<");
    expect(html).toContain("ana <span");
    expect(html).toContain("via Claude Code");
    expect(html).toContain(">Top queryers<");
    expect(html).toContain(">Latest activity<");
    expect(html).toContain("Keep the API in its own repository");
  });

  it("links each write to its node", () => {
    expect(render(codeShell)).toContain('href="/acme-codebase/decision/decision_1"');
  });
});
