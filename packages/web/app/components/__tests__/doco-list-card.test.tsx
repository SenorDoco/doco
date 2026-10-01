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
    template: null,
    items: 127,
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

  it("counts each Doco by the one thing it holds, without a split by stage", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(DocoListCard, {
          docos: [
            {
              id: "doco_prs",
              handle: "torre-prs",
              template: "github-pull-requests",
              items: 52500,
              lastUpdatedAt: "2026-10-01T01:34:00.000Z",
            },
            {
              id: "doco_code",
              handle: "torre-codebase",
              template: "codebase",
              items: 45971,
              lastUpdatedAt: "2026-10-01T01:34:00.000Z",
            },
            {
              id: "doco_bugs",
              handle: "torre-github-bugs",
              template: "github-bugs",
              items: 1,
              lastUpdatedAt: null,
            },
          ],
          empty: createElement("p", null, "none"),
        }),
      ),
    );
    expect(html).toContain("(52,500 pull requests)");
    expect(html).toContain("(45,971 files)");
    expect(html).toContain("(1 bug)");
    expect(html).not.toContain("color:");
  });

  it("counts a Doco with no known template by its nodes", () => {
    expect(render()).toContain("(127 nodes)");
  });

  it("says when each Doco was last updated", () => {
    expect(render()).toContain('dateTime="2026-06-02T00:00:00.000Z"');
    expect(render()).toContain("last updated");
  });
});
