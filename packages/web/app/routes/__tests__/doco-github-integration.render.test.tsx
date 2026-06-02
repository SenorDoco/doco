import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The GitHub integration page is server-wired. Mock the server libs and the
// router/layout primitives so the component renders to static markup, letting
// us assert on the *border styling tokens* it emits — the thing the design
// system cares about and the thing Tailwind v4 silently breaks.
vi.mock("@doco/db", () => ({ roleAtLeast: () => true }));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));
vi.mock("~/lib/db.server", () => ({ docoPath: (handle: string) => `/tmp/docos/${handle}` }));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: () => undefined,
  getDocoLevelRole: () => undefined,
  listAccessibleDocoIdsForPrincipal: () => [],
}));
vi.mock("~/lib/github-backfill.server", () => ({ backfillRepoPullRequests: () => undefined }));
vi.mock("~/lib/github-connection.server", () => ({
  addConnection: () => undefined,
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
  useLoaderData: () => ({
    me: { id: "user_1", username: "alice" },
    handle: "torre-prs",
    ownerSlug: "torre",
    canManage: true,
    docoInstallUrl: "https://github.com/apps/doco/installations/new",
    connections: [{ repo: "torre-labs/discovery", installation_id: 1 }],
    installations: [],
    installationChoices: [],
    backfill: null,
  }),
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

describe("GitHub integration · Connected repositories list", () => {
  it("borders the repo list with the --color-border token, not Tailwind v4's currentColor fallback", () => {
    const html = renderToStaticMarkup(<DocoGitHubIntegration />);
    const match = /<ul class="([^"]*)"/.exec(html);
    expect(match, "connected-repositories <ul> should render").not.toBeNull();
    const className = match?.[1] ?? "";

    // In Tailwind v4 a bare `border` / `divide-y` resolves to `currentColor`
    // (≈ the dark text color) — that's the black box and black row dividers in
    // the screenshot. The list must opt into the subtle slate token via
    // `border-border` / `divide-border`, the way every other bordered surface
    // in this file does.
    expect(className).toContain("border-border");
    expect(className).toContain("divide-border");
  });
});
