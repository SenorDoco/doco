import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({
  withClient: vi.fn(),
}));

vi.mock("@doco/shared", () => ({
  entityUrl: vi.fn(() => "#"),
}));

vi.mock("~/components/site-header", () => ({
  SiteHeader: () => null,
}));

vi.mock("~/lib/doco-access.server", () => ({
  isMyDoco: vi.fn(),
  listInvitedDocoIdsForPrincipal: vi.fn(),
}));

vi.mock("~/lib/doco-stats.server", () => ({
  listDocoStats: vi.fn(),
}));

vi.mock("~/lib/host.server", () => ({
  listAllDocos: vi.fn(),
  listMyWorkspaces: vi.fn(),
  loadHostConfig: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: vi.fn(),
}));

import Dashboard from "../dashboard";

const ALL_DONE = { workspace: true, agent: true, sources: true };

function renderDashboard(onboarding = ALL_DONE): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(Dashboard, {
        loaderData: {
          host: { id: "host_test", name: "Doco", visibility: "public" },
          me: { id: "user_alice", username: "alice", type: "person", isHuman: true },
          greetingVerb: "building",
          accessGroups: [],
          byDay: {},
          feed: [],
          templates: [],
          onboarding,
        } as never,
      }),
    ),
  );
}

describe("Dashboard", () => {
  it("does not render create quick actions in the header", () => {
    const markup = renderDashboard();

    expect(markup).toContain("Good building, alice");
    expect(markup).toContain("Your workspaces and docos");
    expect(markup).not.toContain('href="/new-doco"');
    expect(markup).not.toContain('href="/new-workspace"');
    expect(markup).not.toContain("+ Doco");
    expect(markup).not.toContain("+ Workspace");
  });

  it("walks a new person through the three onboarding steps", () => {
    const markup = renderDashboard({ workspace: false, agent: false, sources: false });
    expect(markup).toContain("Get started");
    expect(markup).toContain("Create a workspace");
    expect(markup).toContain("Connect your agent");
    expect(markup).toContain("Connect sources of knowledge");
  });

  it("drops the onboarding card once every step is done", () => {
    expect(renderDashboard()).not.toContain("Get started");
  });
});
