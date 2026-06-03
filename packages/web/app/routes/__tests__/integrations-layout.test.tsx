import { type ReactElement, type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  docoLoaderData: {
    me: { id: "user_alice", username: "alice", type: "person" as const, isHuman: true },
    handle: "runbook",
    ownerSlug: "acme",
    workspaceHandle: "acme",
    docoInstallUrl: "https://github.com/apps/doco/installations/new",
    github: {
      connected: false,
      orgAccounts: [],
      repoCount: 0,
      importing: false,
      importProgress: null,
    },
  },
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    // Render the route's <Form> as a plain form — static markup has no data
    // router for useSubmit. (Same shim the GitHub render test uses.)
    Form: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
    useLoaderData: () => mocks.docoLoaderData,
    useRevalidator: () => ({ state: "idle", revalidate: vi.fn() }),
  };
});

vi.mock("@doco/db", () => ({
  getWorkspaceRole: vi.fn(),
}));

vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: vi.fn(),
}));

vi.mock("~/lib/github-connection.server", () => ({
  buildInstallUrl: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  githubImportProgress: vi.fn(),
  githubOrgAccounts: vi.fn(),
}));

vi.mock("~/lib/integrations-summary.server", () => ({
  loadAccountIntegrationsRollup: vi.fn(),
  loadWorkspaceIntegrationsRollup: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: vi.fn(),
}));

vi.mock("~/lib/slack.server", () => ({
  getSlackConfig: vi.fn(() => ({ configured: false })),
  listSlackInstallations: vi.fn(),
}));

vi.mock("~/lib/workspace-helpers.server", () => ({
  resolveWorkspaceByHandle: vi.fn(),
}));

vi.mock("~/components/site-header", () => ({
  SiteHeader: () => null,
}));

import DocoIntegrations, { meta as docoIntegrationsMeta } from "../$docoHandle.integrations";
import {
  CONNECTION_ACTION_DESTRUCTIVE,
  CONNECTION_ACTION_SECONDARY,
} from "../../components/integrations-shell";
import { singleColumnPageMainWidth } from "../../components/page-main";
import IntegrationsPage, { meta as accountIntegrationsMeta } from "../integrations";
import WorkspaceIntegrations, {
  meta as workspaceIntegrationsMeta,
} from "../workspaces.$workspaceHandle.integrations";

function renderRoute(element: ReactElement): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, element));
}

function mainClassName(markup: string): string {
  return markup.match(/<main class="([^"]+)"/)?.[1] ?? "";
}

describe("integrations page layout", () => {
  it("uses the same default full-width page container on every integrations page", () => {
    const me = { id: "user_alice", username: "alice", type: "person" as const, isHuman: true };

    const pages = [
      createElement(IntegrationsPage, {
        key: "account",
        loaderData: {
          me,
          notice: null,
          slackConfirmation: null,
          slackInstallHref: null,
          slackInstallations: [],
          removableTeamIds: [],
          rollup: { slack: [], workspaces: [], docos: [] },
          pickingIntegrationId: null,
        },
      }),
      createElement(WorkspaceIntegrations, {
        key: "workspace",
        loaderData: {
          me,
          workspace: { id: "workspace_acme", handle: "acme", name: "Acme", constitution: "" },
          rollup: { workspaceId: "workspace_acme", workspaceHandle: "acme", docos: [] },
          pickingIntegrationId: null,
        },
      }),
      createElement(DocoIntegrations, { key: "doco" }),
    ];

    for (const page of pages) {
      expect(mainClassName(renderRoute(page))).toContain(singleColumnPageMainWidth);
    }
  });

  it("labels every integrations page as app integrations", () => {
    const me = { id: "user_alice", username: "alice", type: "person" as const, isHuman: true };

    const pages = [
      {
        element: createElement(IntegrationsPage, {
          loaderData: {
            me,
            notice: null,
            slackConfirmation: null,
            slackInstallHref: null,
            slackInstallations: [],
            removableTeamIds: [],
            rollup: { slack: [], workspaces: [], docos: [] },
            pickingIntegrationId: null,
          },
        }),
        title: accountIntegrationsMeta()[0]?.title,
      },
      {
        element: createElement(WorkspaceIntegrations, {
          loaderData: {
            me,
            workspace: { id: "workspace_acme", handle: "acme", name: "Acme", constitution: "" },
            rollup: { workspaceId: "workspace_acme", workspaceHandle: "acme", docos: [] },
            pickingIntegrationId: null,
          },
        }),
        title: workspaceIntegrationsMeta({ params: { workspaceHandle: "acme" } })[0]?.title,
      },
      {
        element: createElement(DocoIntegrations),
        title: docoIntegrationsMeta({ params: { docoHandle: "runbook" } })[0]?.title,
      },
    ];

    for (const page of pages) {
      const markup = renderRoute(page.element);
      expect(markup).toContain("App integrations");
      expect(markup).not.toContain(">Integrations</h1>");
      expect(page.title).toContain("App integrations");
    }
  });
});

describe("integrations connected-pane standardization", () => {
  const me = { id: "user_alice", username: "alice", type: "person" as const, isHuman: true };
  const doco = {
    docoId: "doco_1",
    handle: "torre-prs",
    workspaceHandle: "acme",
    githubRepoCount: 4,
  };

  function renderAccountPage(removableTeamIds: string[] = []): string {
    return renderRoute(
      createElement(IntegrationsPage, {
        loaderData: {
          me,
          notice: null,
          slackConfirmation: null,
          slackInstallHref: "/integrations/slack/install",
          slackInstallations: [
            {
              workspaceId: "T1",
              workspaceName: "Torre.ai",
              botUserId: "U1",
              installedAt: "2026-06-03T00:00:00.000Z",
              docoWorkspaceId: null,
            },
          ],
          removableTeamIds,
          rollup: {
            slack: [],
            workspaces: [{ workspaceId: "workspace_acme", handle: "acme", installCount: 0 }],
            docos: [doco],
          },
          pickingIntegrationId: null,
        },
      }),
    );
  }

  function renderWorkspacePage(): string {
    return renderRoute(
      createElement(WorkspaceIntegrations, {
        loaderData: {
          me,
          workspace: { id: "workspace_acme", handle: "acme", name: "Acme", constitution: "" },
          rollup: { workspaceId: "workspace_acme", workspaceHandle: "acme", docos: [doco] },
          pickingIntegrationId: null,
        },
      }),
    );
  }

  it("renders the Slack-workspaces card with the same flush list + action button as the rollups", () => {
    const markup = renderAccountPage();

    // Both the Slack install row and the workspace rollup row sit in flush
    // divider lists — the Slack card's old nested bordered box is gone.
    expect(markup).toContain('<ul class="divide-y divide-border">');
    expect(markup).not.toContain("divide-y divide-border rounded-md border border-border");

    // Both actions ("Set defaults" on Slack, "Manage" on the rollup) render
    // through the one shared secondary-button class, at the same size — the
    // old oversized Slack button (py-2 text-sm) no longer exists.
    expect(markup).toContain("Set defaults");
    expect(markup).toContain("Manage");
    expect(markup).toContain(CONNECTION_ACTION_SECONDARY);
    expect(markup).not.toContain("px-3 py-2 text-sm");

    // The Slack action navigates to its setup screen like any other row.
    expect(markup).toContain('href="/integrations/slack/setup?team_id=T1"');
  });

  it("renders the per-Doco rollup with the same standardized row", () => {
    const markup = renderWorkspacePage();
    expect(markup).toContain('<ul class="divide-y divide-border">');
    expect(markup).toContain("Manage");
    expect(markup).toContain(CONNECTION_ACTION_SECONDARY);
    expect(markup).toContain("4 GitHub repos connected");
  });

  it("shows the Remove control beside Set defaults only for removable teams", () => {
    // Removable (T1 is in the set) → a remove_slack form posts alongside the
    // standardized "Set defaults" action, styled with the shared destructive pill.
    const removable = renderAccountPage(["T1"]);
    expect(removable).toContain("Set defaults");
    expect(removable).toContain("Remove");
    expect(removable).toContain('value="remove_slack"');
    expect(removable).toContain('value="T1"');
    expect(removable).toContain(CONNECTION_ACTION_DESTRUCTIVE);

    // Not removable (empty set) → no remove form at all, just Set defaults.
    const locked = renderAccountPage([]);
    expect(locked).toContain("Set defaults");
    expect(locked).not.toContain("Remove");
    expect(locked).not.toContain('value="remove_slack"');
  });
});
