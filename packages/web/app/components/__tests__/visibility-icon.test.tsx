import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VisibilityIcon } from "../visibility-icon";

describe("VisibilityIcon", () => {
  it("explains a public Doco on hover", () => {
    const html = renderToStaticMarkup(createElement(VisibilityIcon, { visibility: "public" }));
    // The hover title (and matching aria-label) spells out who can view it,
    // mirroring the Settings → Visibility copy.
    expect(html).toContain("anyone with the URL can view");
    expect(html).toContain('data-visibility="public"');
  });

  it("explains a private Doco on hover", () => {
    const html = renderToStaticMarkup(createElement(VisibilityIcon, { visibility: "private" }));
    expect(html).toContain("only owner / workspace members can view");
    expect(html).toContain('data-visibility="private"');
  });

  it("renders distinct icons for public vs private", () => {
    const pub = renderToStaticMarkup(createElement(VisibilityIcon, { visibility: "public" }));
    const priv = renderToStaticMarkup(createElement(VisibilityIcon, { visibility: "private" }));
    expect(pub).not.toEqual(priv);
  });
});
