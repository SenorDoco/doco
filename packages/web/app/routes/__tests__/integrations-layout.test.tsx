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
    github: {
      connected: false,
      orgAccounts: [],
      repoCount: 0,
      importing: false,
      importProgress: null,
    },
    mirrors: [],
  },
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    // Render the route's <Form> as a plain form — static markup has no data
    // router for useSubmit. Forward action/method so tests can assert where a
    // form posts (e.g. Slack removal always targets /integrations).
    Form: ({
      children,
      action,
      method,
    }: {
      children?: ReactNode;
      action?: string;
      method?: string;
    }) => (
      <form action={action} method={method}>
        {children}
      </form>
    ),
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
  getDocoConnectionsContext: vi.fn(),
  githubImportProgress: vi.fn(),
  githubOrgAccounts: vi.fn(),
}));

vi.mock("~/lib/integration-status.server", () => ({
  loadIntegrationStatuses: vi.fn(),
}));

vi.mock("~/lib/integrations-summary.server", () => ({
  loadAccountIntegrationsRollup: vi.fn(),
  loadDocoPicker: vi.fn(),
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
          rollup: { slack: [], workspaces: [], docos: [] },
          docoPicker: null,
        },
      }),
      createElement(WorkspaceIntegrations, {
        key: "workspace",
        loaderData: {
          me,
          workspace: { id: "workspace_acme", handle: "acme", name: "Acme", constitution: "" },
          rollup: { workspaceId: "workspace_acme", workspaceHandle: "acme", docos: [] },
          slack: [],
          canManageSlack: false,
          docoPicker: null,
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
            rollup: { slack: [], workspaces: [], docos: [] },
            docoPicker: null,
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
            slack: [],
            canManageSlack: false,
            docoPicker: null,
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

describe("integrations: Slack folded into the per-workspace rollup", () => {
  const me = { id: "user_alice", username: "alice", type: "person" as const, isHuman: true };
  const doco = {
    docoId: "doco_1",
    handle: "torre-prs",
    workspaceHandle: "acme",
    githubRepoCount: 4,
  };
  const boundTeam = {
    workspaceId: "T1",
    workspaceName: "Torre.ai",
    botUserId: "U1",
    installedAt: "2026-06-03T00:00:00.000Z",
    docoWorkspaceId: "workspace_acme",
  };
  const unboundTeam = {
    workspaceId: "T2",
    workspaceName: "Orphan Co",
    botUserId: null,
    installedAt: "2026-06-03T00:00:00.000Z",
    docoWorkspaceId: null,
  };

  function renderAccountPage(slack = [boundTeam, unboundTeam]): string {
    return renderRoute(
      createElement(IntegrationsPage, {
        loaderData: {
          me,
          notice: null,
          slackConfirmation: null,
          rollup: {
            slack,
            workspaces: [{ workspaceId: "workspace_acme", handle: "acme", installCount: 0 }],
            docos: [doco],
          },
          docoPicker: null,
        },
      }),
    );
  }

  function renderWorkspacePage(opts: { canManageSlack?: boolean } = {}): string {
    return renderRoute(
      createElement(WorkspaceIntegrations, {
        loaderData: {
          me,
          workspace: { id: "workspace_acme", handle: "acme", name: "Acme", constitution: "" },
          rollup: { workspaceId: "workspace_acme", workspaceHandle: "acme", docos: [doco] },
          slack: [{ teamId: "T1", teamName: "Torre.ai", installedAt: "2026-06-03T00:00:00.000Z" }],
          canManageSlack: opts.canManageSlack ?? true,
          docoPicker: null,
        },
      }),
    );
  }

  it("drops the dedicated Slack card and nests a bound team under its workspace, like GitHub", () => {
    const markup = renderAccountPage();

    // No more standalone "Slack workspaces" card.
    expect(markup).not.toContain("Slack workspaces");

    // The bound team is a small read-only entry under its workspace, counted in
    // the same detail line as the GitHub Docos — exactly like a GitHub entry.
    expect(markup).toContain("Torre.ai");
    expect(markup).toContain("1 doco with connections");
    expect(markup).toContain("1 Slack team");

    // Standardized rollup chrome is unchanged.
    expect(markup).toContain('<ul class="divide-y divide-border">');
    expect(markup).toContain(CONNECTION_ACTION_SECONDARY);
    expect(markup).not.toContain("px-3 py-2 text-sm");

    // A bound team is managed by drilling in (no inline Remove on this page).
    expect(markup).not.toContain('value="T1"');
  });

  it("lists unbound teams in a 'not linked' fallback whose Remove posts to /integrations", () => {
    const markup = renderAccountPage();
    expect(markup).toContain("Slack teams not linked to a workspace");
    expect(markup).toContain("Orphan Co");
    expect(markup).toContain('value="remove_slack"');
    expect(markup).toContain('value="T2"');
    expect(markup).toContain(CONNECTION_ACTION_DESTRUCTIVE);
    // Removal posts to the canonical /integrations action from wherever it's shown.
    expect(markup).toContain('action="/integrations"');
  });

  it("omits the fallback (and any Remove) when every team is bound", () => {
    const markup = renderAccountPage([boundTeam]);
    expect(markup).not.toContain("not linked to a workspace");
    expect(markup).not.toContain("Remove");
  });

  it("manages Slack on the workspace page: Set defaults for members, Remove for owners", () => {
    const owner = renderWorkspacePage({ canManageSlack: true });
    expect(owner).toContain("Workspace-level integrations");
    expect(owner).toContain("Torre.ai");
    expect(owner).toContain("Set defaults");
    expect(owner).toContain('href="/integrations/slack/setup?team_id=T1"');
    expect(owner).toContain("Remove");
    expect(owner).toContain(CONNECTION_ACTION_DESTRUCTIVE);
    // The per-Doco rollup stays standardized.
    expect(owner).toContain("4 GitHub repos connected");
    expect(owner).toContain(CONNECTION_ACTION_SECONDARY);

    const member = renderWorkspacePage({ canManageSlack: false });
    expect(member).toContain("Set defaults");
    expect(member).not.toContain("Remove");
  });
});

describe("integrations: Set up... on a Doco-level integration picks the doco", () => {
  const me = { id: "user_alice", username: "alice", type: "person" as const, isHuman: true };

  function workspace(handle: string, docos: string[]) {
    return {
      id: `workspace_${handle}`,
      handle,
      name: handle,
      role: "owner" as const,
      docos: docos.map((d) => ({ id: `doco_${d}`, handle: d, template: null })),
      lastActivityAt: null,
    };
  }

  type Picker = { integrationId: string; workspaces: ReturnType<typeof workspace>[] } | null;

  function renderWorkspacePage(docoPicker: Picker): string {
    return renderRoute(
      createElement(WorkspaceIntegrations, {
        loaderData: {
          me,
          workspace: { id: "workspace_acme", handle: "acme", name: "Acme", constitution: "" },
          rollup: { workspaceId: "workspace_acme", workspaceHandle: "acme", docos: [] },
          slack: [],
          canManageSlack: true,
          docoPicker,
        },
      }),
    );
  }

  function renderAccountPage(docoPicker: Picker): string {
    return renderRoute(
      createElement(IntegrationsPage, {
        loaderData: {
          me,
          notice: null,
          slackConfirmation: null,
          rollup: { slack: [], workspaces: [], docos: [] },
          docoPicker,
        },
      }),
    );
  }

  it("sends GitHub and Notion's Set up... to the page's doco picker", () => {
    const markup = renderWorkspacePage(null);
    expect(markup).toContain('href="/workspaces/acme/integrations?integration=github"');
    expect(markup).toContain('href="/workspaces/acme/integrations?integration=notion"');
    expect(renderAccountPage(null)).toContain('href="/integrations?integration=github"');
  });

  it("lists every doco in the workspace, each linking to its own setup page", () => {
    const markup = renderWorkspacePage({
      integrationId: "github",
      workspaces: [workspace("acme", ["acme-bugs", "acme-ideas"])],
    });
    expect(markup).toContain("Pick a doco to set up GitHub");
    expect(markup).toContain('href="/acme-bugs/integrations/github"');
    expect(markup).toContain('href="/acme-ideas/integrations/github"');
  });

  it("lists the docos of every workspace on the account page", () => {
    const markup = renderAccountPage({
      integrationId: "notion",
      workspaces: [workspace("acme", ["acme-bugs"]), workspace("torre", ["torre-ideas"])],
    });
    expect(markup).toContain("Pick a doco to set up Notion");
    expect(markup).toContain('href="/acme-bugs/integrations/notion"');
    expect(markup).toContain('href="/torre-ideas/integrations/notion"');
  });

  it("says so when there is no doco to set it up on", () => {
    const markup = renderWorkspacePage({ integrationId: "github", workspaces: [] });
    expect(markup).toContain("Pick a doco to set up GitHub");
    expect(markup).toContain("No docos to set up GitHub on yet.");
  });
});
