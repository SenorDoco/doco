import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { DocoListCard, type DocoListEntry } from "../doco-list-card";

const docos: DocoListEntry[] = [
  {
    id: "doco_torr",
    handle: "torr",
    ownerHandle: "torre",
    nodeCount: 127,
    lastUpdatedAt: "2026-06-02T00:00:00.000Z",
    visibility: "public",
  },
];

function render(showOwner?: boolean): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(DocoListCard, {
        title: "Docos in this workspace",
        docos,
        empty: createElement("p", null, "none"),
        showOwner,
      }),
    ),
  );
}

describe("DocoListCard", () => {
  it("prefixes each entry with the owner handle by default", () => {
    const html = render();
    expect(html).toContain("torre / torr");
  });

  it("shows just the Doco name (no owner prefix) when showOwner is false", () => {
    const html = render(false);
    expect(html).toContain(">torr<");
    expect(html).not.toContain("torre / torr");
  });

  it("passes each Doco's visibility through to an explained icon", () => {
    const html = render();
    expect(html).toContain('data-visibility="public"');
    expect(html).toContain("anyone with the URL can view");
  });
});
