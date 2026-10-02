import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS: [], withClient: vi.fn() }));
vi.mock("~/lib/doco-access.server", () => ({ loadDocoRouteForRead: vi.fn() }));
vi.mock("~/lib/host.server", () => ({ loadHostConfig: vi.fn() }));
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: vi.fn() }));

const { default: ListByTypeInDoco } = await import("../$docoHandle.$type._index");

// The page is set in Merriweather; an id is an identifier, so like ids
// everywhere else (node dialog, search, policies) it stays monospace.
describe("a Doco's list of one node type", () => {
  it("shows a bare id in monospace and a name in the page's face", () => {
    const loaderData = {
      items: [
        { id: "decision_01M3YP6F30RY70FDM3VMD7EANT", summary: "Ship the reader", name: null },
        { id: "decision_01M3YP6F1M7DC8K8VPWAAXMFWS", summary: "Drop serifs", name: "Typeface" },
      ],
      type: "decision",
      ownerSlug: "acme",
      docoSlug: "playground",
      handle: "playground",
      host: {},
      me: null,
    } as unknown as Parameters<typeof ListByTypeInDoco>[0]["loaderData"];

    const markup = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ListByTypeInDoco, { loaderData })),
    );

    const linkClass = (text: string) =>
      markup.match(new RegExp(`<a[^>]*class="([^"]*)"[^>]*>${text}</a>`))?.[1] ?? "";
    expect(linkClass("decision_01M3YP6F30RY70FDM3VMD7EANT")).toMatch(/(?:^|\s)font-mono(?:\s|$)/);
    expect(linkClass("Typeface")).not.toMatch(/font-mono/);
  });
});
