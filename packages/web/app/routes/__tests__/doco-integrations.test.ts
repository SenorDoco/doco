import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  buildInstallUrl: vi.fn(),
  loadIntegrationStatuses: vi.fn(),
}));

vi.mock("@doco/db", () => ({ withClient: (fn: (c: unknown) => unknown) => fn({}) }));

vi.mock("~/lib/integration-status.server", () => ({
  loadIntegrationStatuses: mocks.loadIntegrationStatuses,
}));

vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
}));

vi.mock("~/lib/github-connection.server", () => ({
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
  buildInstallUrl: mocks.buildInstallUrl,
  githubOrgAccounts: ({
    installations,
    connections,
  }: {
    installations: unknown[];
    connections: Array<{ repo: string }>;
  }) =>
    installations.length > 0
      ? ["torre-labs"]
      : [...new Set(connections.map((connection) => connection.repo.split("/")[0]))],
  // Pure helper re-implemented inline (the canonical impl is unit-tested in
  // github-connection.server.test.ts); here we only assert the loader surfaces
  // its result to the UI.
  githubImportProgress: (
    backfill: { status?: string; repos?: number; repo_index?: number } | null,
  ) =>
    backfill && backfill.status === "running" && (backfill.repos ?? 0) > 0
      ? { done: Math.min(backfill.repo_index ?? 0, backfill.repos ?? 0), total: backfill.repos }
      : null,
}));

import { ImportingNote, loader } from "../$docoHandle.integrations";

const routeArgs = { params: { docoHandle: "torre-prs" } };
const request = new Request("https://doco.test/torre-prs/integrations");

describe("/:docoHandle/integrations (index)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "user_1", username: "alice" },
      meta: { docoId: "doco_1", ownerId: "workspace_1", handle: "torre-prs" },
      ownerSlug: "torre",
    });
    mocks.buildInstallUrl.mockReturnValue(null);
    mocks.loadIntegrationStatuses.mockResolvedValue([]);
  });

  it("surfaces the Doco's Slack mirror", async () => {
    mocks.getDocoConnectionsContext.mockResolvedValue(null);
    const slack = { integration: "slack", teamName: "Torre", state: "importing" };
    mocks.loadIntegrationStatuses.mockResolvedValue([slack]);

    const data = await loader({ request, ...routeArgs });

    expect(mocks.loadIntegrationStatuses).toHaveBeenCalledWith({}, "doco_1");
    expect(data.slack).toEqual(slack);
  });

  it("surfaces repo import progress while a backfill is running", async () => {
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "torre-prs",
      workspaceHandle: "torre",
      connections: [
        { repo: "torre-labs/a", installation_id: 1 },
        { repo: "torre-labs/b", installation_id: 1 },
        { repo: "torre-labs/c", installation_id: 1 },
        { repo: "torre-labs/d", installation_id: 1 },
      ],
      installations: [],
      backfill: { status: "running", repos: 4, repo_index: 2, imported: 137 },
    });

    const data = await loader({ request, ...routeArgs });

    expect(data.github.importing).toBe(true);
    expect(data.github.importProgress).toEqual({ done: 2, total: 4 });
  });

  it("exposes no progress when nothing is importing", async () => {
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "torre-prs",
      workspaceHandle: "torre",
      connections: [{ repo: "torre-labs/a", installation_id: 1 }],
      installations: [],
      backfill: null,
    });

    const data = await loader({ request, ...routeArgs });

    expect(data.github.importing).toBe(false);
    expect(data.github.importProgress).toBeNull();
  });
});

describe("ImportingNote (rendered markup)", () => {
  it("renders the running 'X of Y' count alongside an animated spinner", () => {
    const markup = renderToStaticMarkup(
      createElement(ImportingNote, { progress: { done: 2, total: 4 } }),
    );
    expect(markup).toContain("importing");
    expect(markup).toContain(">2</span>");
    expect(markup).toContain(" of ");
    expect(markup).toContain(">4</span>");
    // The spinner is the "more animated" affordance the user asked for.
    expect(markup).toContain("animate-spin");
  });

  it("falls back to a plain 'importing' label + spinner when the total is unknown", () => {
    const markup = renderToStaticMarkup(createElement(ImportingNote, { progress: null }));
    expect(markup).toContain("importing");
    expect(markup).toContain("animate-spin");
    expect(markup).not.toContain(" of ");
  });
});
