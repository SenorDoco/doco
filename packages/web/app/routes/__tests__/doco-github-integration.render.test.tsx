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

describe("GitHub integration · neumorphic roles", () => {
  it("lists the connected repositories on a slab with faint dividers", () => {
    fixture.loaderData = {
      ...baseLoaderData,
      connections: [{ repo: "torre-labs/discovery", installation_id: 1 }],
    };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);
    const tokens = classListOf(html, (cls) => cls.includes("divide-y"));
    expect(tokens, "connected-repositories <ul> should render").toBeDefined();

    // One clay: a list is a slab (`neu-surface`), never an outlined box, and
    // its rows are parted by the one line left, `divide-border` (a bare
    // `divide-y` would fall back to currentColor and draw black rules).
    expect(tokens).toContain("neu-surface");
    expect(tokens).toContain("divide-border");
    expect(tokens).not.toContain("border");
  });

  it("lists the connected repositories A to Z, ignoring case", () => {
    fixture.loaderData = {
      ...baseLoaderData,
      connections: [
        { repo: "acme/Zeta", installation_id: 1 },
        { repo: "acme/alpha", installation_id: 1 },
        { repo: "acme/Beta", installation_id: 1 },
      ],
    };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);
    const listed = [...html.matchAll(/<span class="font-mono text-sm">([^<]+)<\/span>/g)].map(
      (m) => m[1],
    );
    expect(listed).toEqual(["acme/alpha", "acme/Beta", "acme/Zeta"]);
  });

  it("makes each option to pick a key, since the whole row is clickable", () => {
    fixture.loaderData = { ...baseLoaderData, installationChoices: [torrenegra] };

    const html = renderToStaticMarkup(<DocoGitHubIntegration />);
    const labels = [...html.matchAll(/<label class="([^"]*)"/g)].map((m) => m[1]?.split(/\s+/));
    expect(labels, "For all repositories and Select repositories").toHaveLength(2);

    for (const tokens of labels) {
      expect(tokens).toContain("neu-button");
      expect(tokens).not.toContain("border");
    }
    // No repository is listed until Select repositories is chosen.
    expect(repoCheckboxes(html)).toEqual([]);
  });
});
