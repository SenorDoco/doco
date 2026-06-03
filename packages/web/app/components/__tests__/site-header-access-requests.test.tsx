import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AccessRequestsNavItem } from "../site-header";

function render(props: Parameters<typeof AccessRequestsNavItem>[0]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AccessRequestsNavItem, props)),
  );
}

describe("AccessRequestsNavItem", () => {
  it("renders nothing when no requests are waiting", () => {
    expect(render({ pending: 0 })).toBe("");
    expect(render({ pending: null })).toBe("");
    expect(render({ pending: undefined })).toBe("");
  });

  it("links to the inbox with a count badge while requests are pending", () => {
    const html = render({ pending: 3 });
    expect(html).toContain('href="/access-requests"');
    expect(html).toContain("Access requests");
    // The pending tally is surfaced as a badge.
    expect(html).toContain("3");
    // Accessible summary for screen readers.
    expect(html).toContain("3 pending access requests");
  });

  it("singularizes the accessible summary for a lone request", () => {
    const html = render({ pending: 1 });
    expect(html).toContain("1 pending access request");
    expect(html).not.toContain("1 pending access requests");
  });
});
