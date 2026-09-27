// A Doco that mirrors a Slack workspace lists it under "Connected on this
// doco", with a Manage link to the mirror's page — the page is reachable, and
// the Doco no longer reads as having nothing connected.
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { SlackIntegrationStatus } from "~/lib/integration-status.server";

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

const slack: SlackIntegrationStatus = {
  integration: "slack",
  teamName: "Torre",
  latestAt: null,
  state: "importing",
  backTo: null,
  since: "2020-09-27T00:00:00.000Z",
  channelsDone: 0,
  channels: 40,
  threadsPending: 0,
};

function render(slackStatus: SlackIntegrationStatus | null): string {
  mocks.loaderData = {
    me: { id: "user_alex", username: "alex", type: "person", isHuman: true },
    handle: "torre-slack",
    ownerSlug: "torre",
    workspaceHandle: "torre",
    docoInstallUrl: null,
    github: {
      connected: false,
      orgAccounts: [],
      repoCount: 0,
      importing: false,
      importProgress: null,
    },
    slack: slackStatus,
  };
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DocoIntegrations)));
}

describe("/:docoHandle/integrations", () => {
  it("lists a Slack mirror as connected, with a link to manage it", () => {
    const html = render(slack);
    expect(html).toContain("Slack integration");
    expect(html).toContain('href="/torre-slack/integrations/slack"');
    expect(html).not.toContain("Nothing connected yet");
  });

  it("says nothing is connected when the Doco copies from nothing", () => {
    expect(render(null)).toContain("Nothing connected yet");
  });
});
