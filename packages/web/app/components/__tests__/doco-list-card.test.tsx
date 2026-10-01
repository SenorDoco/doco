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

  it("places the visibility marker to the left of the Doco name", () => {
    const html = render(false);
    const marker = html.indexOf('data-visibility="public"');
    const name = html.indexOf(">torr<");
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(name);
  });

  it("counts what a Doco copied from its source, which are not nodes", () => {
    const empty = { drafting: 0, queued: 0, active: 0, retired: 0 };
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(DocoListCard, {
          docos: [
            {
              id: "doco_code",
              handle: "torre-codebase",
              nodeCount: 0,
              counts: empty,
              copied: { count: 1215, unit: "file" },
              lastUpdatedAt: "2026-10-01T01:34:00.000Z",
            },
            {
              id: "doco_slack",
              handle: "torre-slack",
              nodeCount: 0,
              counts: empty,
              copied: { count: 48210, unit: "message" },
              lastUpdatedAt: "2026-09-30T01:34:00.000Z",
            },
            {
              id: "doco_notion",
              handle: "torre-notion",
              nodeCount: 3,
              counts: { ...empty, active: 3 },
              copied: { count: 1, unit: "page" },
              lastUpdatedAt: null,
            },
          ],
          empty: createElement("p", null, "none"),
        }),
      ),
    );
    expect(html).toContain("(1,215 files)");
    expect(html).toContain("(48,210 messages)");
    expect(html).toContain(" · 1 page)");
  });
});
