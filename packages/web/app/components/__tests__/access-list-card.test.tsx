import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AccessListCard, type AccessListItem } from "../access-list-card";

// Distinct ISO stamps so we can assert on each row independently.
const WORKSPACE_ISO = "2026-01-02T03:04:05.000Z";
const DOCO_ISO = "2026-02-03T04:05:06.000Z";

// Mirrors the dashboard's "Your workspaces and docos" shape: workspaces are
// group rows (they carry a `children` array, even when empty); docos are leaf
// rows (no `children`).
const items: AccessListItem[] = [
  {
    id: "ws_meta",
    href: "/workspaces/meta-doco",
    label: "meta-doco",
    count: 937,
    lastUpdatedAt: WORKSPACE_ISO,
    children: [
      {
        id: "doco_prs",
        href: "/meta-pull-requests",
        label: "meta-pull-requests",
        count: 911,
        lastUpdatedAt: DOCO_ISO,
        visibility: "private",
      },
    ],
  },
  {
    id: "ws_empty",
    href: "/workspaces/torrenegra",
    label: "torrenegra",
    count: 0,
    lastUpdatedAt: null,
    children: [],
  },
];

function render(): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(AccessListCard, {
        title: "Your workspaces and docos",
        items,
        empty: createElement("p", null, "none"),
      }),
    ),
  );
}

describe("AccessListCard", () => {
  it("hides the last-updated stamp on workspace (group) rows", () => {
    const html = render();
    // The workspace's own timestamp is not rendered...
    expect(html).not.toContain(WORKSPACE_ISO);
    // ...and an activity-free workspace shows no "no activity yet" filler.
    expect(html).not.toContain("no activity yet");
  });

  it("keeps the last-updated stamp on Doco (leaf) rows", () => {
    const html = render();
    expect(html).toContain(DOCO_ISO);
    expect(html).toContain("last updated");
  });

  it("marks a Doco's visibility with an explained icon, but not workspace rows", () => {
    const html = render();
    // Leaf Doco rows carry a visibility marker whose hover title explains it.
    expect(html).toContain('data-visibility="private"');
    expect(html).toContain("only owner / workspace members can view");
    // Group (workspace) rows have no visibility, so no marker leaks onto them.
    expect(html).not.toContain('data-visibility="public"');
  });
});
