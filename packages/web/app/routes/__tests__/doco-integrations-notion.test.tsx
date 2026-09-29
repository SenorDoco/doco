// A Doco that mirrors a Notion workspace lists it under "Connected on this
// doco", with a Manage link to the mirror's page.
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { NotionIntegrationStatus } from "~/lib/integration-status.server";

const mocks = vi.hoisted(() => ({ loaderData: {} as Record<string, unknown> }));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    Form: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
    useLoaderData: () => mocks.loaderData,
    useRevalidator: () => ({ state: "idle", revalidate: vi.fn() }),
  };
});
vi.mock("@doco/db", () => ({ withClient: vi.fn(), getWorkspaceRole: vi.fn() }));
vi.mock("~/lib/doco-access.server", () => ({ loadDocoRouteForRead: vi.fn() }));
vi.mock("~/lib/github-connection.server", () => ({
  buildInstallUrl: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  githubImportProgress: vi.fn(),
  githubOrgAccounts: vi.fn(),
}));
vi.mock("~/lib/integration-status.server", () => ({ loadIntegrationStatuses: vi.fn() }));
vi.mock("~/lib/slack.server", () => ({ getSlackConfig: vi.fn(() => ({ configured: true })) }));
vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));

import DocoIntegrations from "../$docoHandle.integrations";

const notion: NotionIntegrationStatus = {
  integration: "notion",
  workspaceName: "Acme",
  latestAt: null,
  state: "importing",
  needsReauth: false,
  pagesDone: 12,
  pages: 40,
  listingCapped: false,
};

function render(status: NotionIntegrationStatus | null): string {
  mocks.loaderData = {
    me: { id: "user_alex", username: "alex", type: "person", isHuman: true },
    handle: "acme-notion",
    ownerSlug: "acme",
    workspaceHandle: "acme",
    docoInstallUrl: null,
    github: {
      connected: false,
      orgAccounts: [],
      repoCount: 0,
      importing: false,
      importProgress: null,
    },
    mirrors: status ? [status] : [],
  };
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DocoIntegrations)));
}

describe("/:docoHandle/integrations", () => {
  it("lists a Notion mirror as connected, with a link to manage it", () => {
    const html = render(notion);
    expect(html).toContain("Notion integration");
    expect(html).toContain("Copying pages: 12 of 40 pages");
    expect(html).toContain('href="/acme-notion/integrations/notion"');
    expect(html).not.toContain("Nothing connected yet");
  });

  it("offers Notion in the catalog at Doco scope", () => {
    const html = render(null);
    expect(html).toContain('href="/acme-notion/integrations/notion"');
    expect(html).toContain("Nothing connected yet");
  });
});
