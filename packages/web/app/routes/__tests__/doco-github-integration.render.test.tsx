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

vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));
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
  },
  canManage: true,
  docoInstallUrl: "https://github.com/apps/doco/installations/new",
  connections: [] as Array<{ repo: string; installation_id: number }>,
  installations: [] as Array<{ installation_id: number; account: string }>,
  installationChoices: [] as unknown[],
  backfill: null,
};

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

  it("gives the installation org-group box the exact border-border token so it gets the etched edge", () => {
    fixture.loaderData = {
      ...baseLoaderData,
      installationChoices: [
        {
          installation_id: 7,
          account: "torrenegra",
          repositories: ["torrenegra/doco"],
          connected_repositories: [],
          source_doco_handles: ["torre-prs"],
        },
      ],
    };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);
    const tokens = classListOf(html, (cls) => cls.includes("rounded-md") && cls.includes("p-3"));
    expect(tokens, "installation org-group box should render").toBeDefined();

    // app.css applies the neumorphic etched highlight via a whitespace-token
    // selector: `[class~="border"][class~="border-border"]`. An opacity modifier
    // (`border-border/80`) is a DIFFERENT token, so the box would render a flat
    // line and miss the etched edge every sibling surface has. It must carry the
    // exact `border-border` token.
    expect(tokens).toContain("border");
    expect(tokens).toContain("border-border");
  });
});
