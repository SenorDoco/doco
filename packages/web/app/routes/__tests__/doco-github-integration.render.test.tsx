import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The GitHub integration page is server-wired. Mock the server libs and the
// router/layout primitives so the component renders to static markup, letting
// us assert on the *border styling tokens* it emits — the thing the design
// system cares about and the thing Tailwind v4 silently breaks.
const fixture = vi.hoisted(() => ({ loaderData: undefined as unknown }));

vi.mock("@doco/db", () => ({ roleAtLeast: () => true }));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));
vi.mock("~/lib/db.server", () => ({ docoPath: (handle: string) => `/tmp/docos/${handle}` }));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: () => undefined,
  getDocoLevelRole: () => undefined,
  listAccessibleDocoIdsForPrincipal: () => [],
}));
vi.mock("~/lib/github-backfill.server", () => ({ repoBackfillFor: () => undefined }));
vi.mock("~/lib/github-connection.server", () => ({
  connectRepositories: () => undefined,
  pickRepositories: () => ({ repos: [] }),
  buildInstallUrl: () => "",
  getDocoConnectionsContext: () => undefined,
  githubOrgAccounts: () => [],
  listGitHubInstallationChoicesForDocos: () => [],
  parseRepoSlug: () => null,
  reconcileInstallationConnections: () => undefined,
  removeConnection: () => undefined,
  resumeCursorFromConnections: () => ({}),
  setBackfillState: () => undefined,
  subscribeInstallation: () => undefined,
}));
vi.mock("../api.github.backfill-run", () => ({ kickBackfillRun: () => undefined }));

vi.mock("react-router", () => ({
  Form: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
  redirect: (url: string) => url,
  useLoaderData: () => fixture.loaderData,
  useActionData: () => undefined,
  useSearchParams: () => [new URLSearchParams("")],
}));

vi.mock("~/components/breadcrumb", () => ({
  Breadcrumb: () => null,
  docoBreadcrumb: () => [],
}));
vi.mock("~/components/card", () => ({
  Card: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CardContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import { connectLabel } from "~/components/github-repo-picker";
import DocoGitHubIntegration from "../$docoHandle.integrations.github";

const baseLoaderData = {
  me: { id: "user_1", username: "alice" },
  handle: "torre-prs",
  ownerSlug: "torre",
  brings: {
    id: "pull-requests",
    template: "github-pull-requests",
    label: "Pull requests",
    description: "Every pull request.",
    item: "pull request",
    items: "pull requests",
    permission: "Pull requests",
  },
  canManage: true,
  docoInstallUrl: "https://github.com/apps/doco/installations/new",
  connections: [] as Array<{ repo: string; installation_id: number }>,
  installations: [] as Array<{ installation_id: number; account: string }>,
  installationChoices: [] as unknown[],
  backfill: null,
};

const torrenegra = {
  installation_id: 7,
  account: "torrenegra",
  repositories: ["torrenegra/doco"],
  connected_repositories: [],
  source_doco_handles: ["torre-prs"],
};
const torreLabs = { ...torrenegra, installation_id: 8, account: "torre-labs" };
torreLabs.repositories = ["torre-labs/heda", "torre-labs/vader"];

/** The repositories offered as checkboxes, in order. */
function repoCheckboxes(html: string): string[] {
  return [...html.matchAll(/<input type="checkbox"[^>]*name="repo" value="([^"]+)"/g)].map(
    (m) => m[1] ?? "",
  );
}

function classListOf(html: string, predicate: (cls: string) => boolean): string[] | undefined {
  for (const m of html.matchAll(/<(?:ul|div) class="([^"]*)"/g)) {
    const cls = m[1] ?? "";
    if (predicate(cls)) return cls.split(/\s+/);
  }
  return undefined;
}

describe("GitHub integration · border styling tokens", () => {
  it("borders the connected-repos list with the --color-border token, not Tailwind v4's currentColor fallback", () => {
    fixture.loaderData = {
      ...baseLoaderData,
      connections: [{ repo: "torre-labs/discovery", installation_id: 1 }],
    };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);
    const tokens = classListOf(html, (cls) => cls.includes("divide-y"));
    expect(tokens, "connected-repositories <ul> should render").toBeDefined();

    // In Tailwind v4 a bare `border` / `divide-y` resolves to `currentColor`
    // (≈ the dark text color) — the black box and black row dividers. The list
    // must opt into the subtle slate token via `border-border`/`divide-border`.
    expect(tokens).toContain("border-border");
    expect(tokens).toContain("divide-border");
  });

  it("gives each repository to pick the exact border-border token so it gets the etched edge", () => {
    fixture.loaderData = { ...baseLoaderData, installationChoices: [torrenegra] };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);
    const tokens = html.match(/<label class="([^"]*)"/)?.[1]?.split(/\s+/);
    expect(tokens, "repository checkbox should render").toBeDefined();

    // app.css applies the neumorphic etched highlight via a whitespace-token
    // selector: `[class~="border"][class~="border-border"]`. An opacity modifier
    // (`border-border/80`) is a DIFFERENT token, so the box would render a flat
    // line and miss the etched edge every sibling surface has. It must carry the
    // exact `border-border` token.
    expect(tokens).toContain("border");
    expect(tokens).toContain("border-border");
  });
});

// Right after a GitHub Doco is created, New Doco lands here: the page is the
// step that connects it, not a settings page with an empty list on top.
describe("GitHub integration · connecting a new Doco", () => {
  it("asks for the repositories, all in one list with one button, and lets the user skip", () => {
    fixture.loaderData = { ...baseLoaderData, installationChoices: [torreLabs, torrenegra] };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);

    expect(html).toContain("Pick repositories");
    expect(html).toContain("Nothing comes in until you connect at least one.");
    expect(html).not.toContain("Connected repositories");
    // Every organization's repositories share one form and one button.
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(repoCheckboxes(html)).toEqual([
      "torre-labs/heda",
      "torre-labs/vader",
      "torrenegra/doco",
    ]);
    expect(html).toMatch(/<button type="submit"[^>]*disabled="">Connect repositories<\/button>/);
    expect(html).toContain('href="/torre-prs">Skip for now</a>');
    expect(html).toContain("Don&#x27;t see a repository?");
  });

  it("lists what is connected and offers only the rest once a repository is in", () => {
    fixture.loaderData = {
      ...baseLoaderData,
      connections: [{ repo: "torre-labs/heda", installation_id: 8 }],
      installationChoices: [torreLabs, torrenegra],
    };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);

    expect(html).toContain("Connected repositories");
    expect(html).toContain("Add repositories");
    expect(html).not.toContain("Skip for now");
    expect(repoCheckboxes(html)).toEqual(["torre-labs/vader", "torrenegra/doco"]);
  });
});

// An organization can hold a hundred repositories: picking them one by one
// doesn't work, so each organization can be picked as a whole.
describe("GitHub integration · a whole organization at once", () => {
  it("offers each organization as a whole, ahead of its repositories", () => {
    fixture.loaderData = {
      ...baseLoaderData,
      installationChoices: [torreLabs, { ...torrenegra, repository_selection: "all" }],
    };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);

    expect(
      [...html.matchAll(/<input type="checkbox"[^>]*name="installation" value="(\d+)"/g)].map(
        (m) => m[1],
      ),
    ).toEqual(["8", "7"]);
    // GitHub shows Doco only the repositories chosen for it in torre-labs…
    expect(html).toContain(
      "Every repository Doco can see in torre-labs (2), including ones you give it later",
    );
    // …and every repository in torrenegra.
    expect(html).toContain("Every repository in torrenegra (1), including ones added later");
    expect(html.indexOf('value="8"')).toBeLessThan(html.indexOf('value="torre-labs/heda"'));
  });
});

describe("connectLabel", () => {
  it("says what the button connects", () => {
    expect(connectLabel(0, [])).toBe("Connect repositories");
    expect(connectLabel(1, [])).toBe("Connect 1 repository");
    expect(connectLabel(3, [])).toBe("Connect 3 repositories");
    expect(connectLabel(2, ["acme"])).toBe("Connect 2 repositories and every repository in acme");
  });
});

describe("GitHub integration · access GitHub refused", () => {
  it("links to GitHub to accept the access the App asks for", () => {
    fixture.loaderData = {
      ...baseLoaderData,
      connections: [{ repo: "torre-labs/discovery", installation_id: 1 }],
      backfill: {
        status: "done",
        repos: 1,
        skipped: 1,
        errors: [{ repo: "torre-labs/discovery", message: "403", at: "t", status: 403 }],
      },
    };
    const html = renderToStaticMarkup(<DocoGitHubIntegration />);
    expect(html).toContain("Accept the App&#x27;s request for Pull requests access in GitHub.");
    expect(html).toMatch(
      /<a href="https:\/\/github\.com\/apps\/doco\/installations\/new"[^>]*>Review in GitHub<\/a>/,
    );
  });
});
