// A Doco's settings page leads to its policies. A codebase or Notion Doco
// opens in the reader, which has no perspectives, so its settings offer no
// default perspective to pick.
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, Form: ({ children }: { children?: ReactNode }) => <form>{children}</form> };
});
vi.mock("@doco/db", () => ({ withClient: vi.fn(), getWorkspaceRole: vi.fn() }));
vi.mock("~/lib/doco-access.server", () => ({ loadDocoRouteForAdmin: vi.fn() }));
vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));

import DocoSettings from "../$docoHandle.settings";

type LoaderData = Parameters<typeof DocoSettings>[0]["loaderData"];

function render(overrides: Partial<LoaderData>): string {
  const loaderData = {
    ownerSlug: "acme",
    handle: "acme-codebase",
    docoId: "doco_1",
    ownerId: "workspace_acme",
    workspaceId: "workspace_acme",
    visibility: "private",
    goal: "",
    reader: null,
    perspectives: [{ id: "perspective_graph", name: "Graph", isDefault: true }],
    availableOwnerWorkspaces: [],
    me: null,
    ...overrides,
  } as unknown as LoaderData;
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(DocoSettings, { loaderData })),
  );
}

describe("/:docoHandle/settings", () => {
  it("leads to the Doco's policies", () => {
    expect(render({})).toMatch(/href="\/acme-codebase\/policies"/);
  });

  it("offers a default perspective on a Doco with perspectives", () => {
    expect(render({})).toContain("Default perspective");
  });

  it("offers none on a Doco that opens in the reader", () => {
    expect(render({ reader: "code" })).not.toContain("Default perspective");
  });
});
