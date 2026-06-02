import { type ReactElement, createElement } from "react";
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

import DocoIntegrations from "../$docoHandle.integrations";
import IntegrationsPage from "../integrations";
import WorkspaceIntegrations from "../workspaces.$workspaceHandle.integrations";

const expectedMainWidthClass = "mx-auto w-full max-w-6xl";

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
      expect(mainClassName(renderRoute(page))).toContain(expectedMainWidthClass);
    }
  });
});
