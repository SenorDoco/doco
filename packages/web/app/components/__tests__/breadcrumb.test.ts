import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Breadcrumb, type BreadcrumbItem, docoBreadcrumb } from "../breadcrumb";

function renderTrail(items: BreadcrumbItem[]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(Breadcrumb, { items })),
  );
}

describe("docoBreadcrumb", () => {
  it("keeps Home and the owning organization in doco-scoped trails", () => {
    expect(docoBreadcrumb({ ownerSlug: "torre", handle: "meta-pull-requests" })).toEqual([
      { label: "Home", to: "/" },
      { label: "torre", to: "/orgs/torre" },
      { label: "meta-pull-requests", to: "/meta-pull-requests" },
    ]);
  });

  it("appends parent and page labels after the Doco", () => {
    expect(
      docoBreadcrumb({
        ownerSlug: "torre",
        handle: "meta-pull-requests",
        parent: { label: "Policies", to: "/meta-pull-requests/policies" },
        pageLabel: "Guidance",
      }),
    ).toEqual([
      { label: "Home", to: "/" },
      { label: "torre", to: "/orgs/torre" },
      { label: "meta-pull-requests", to: "/meta-pull-requests" },
      { label: "Policies", to: "/meta-pull-requests/policies" },
      { label: "Guidance" },
    ]);
  });
});

describe("Breadcrumb rendering", () => {
  it("renders the current (last) item as a link when it has a destination", () => {
    // The screenshot case: on /orgs/torre the trail is `Orgs › torre` and
    // `torre` is the current page but still has a `to`. It must be clickable.
    const markup = renderTrail([
      { label: "Orgs", to: "/orgs" },
      { label: "torre", to: "/orgs/torre" },
    ]);
    // The current item is an anchor to its own page, still flagged as current.
    // Attribute order in the rendered <a> isn't guaranteed, so assert on the
    // extracted anchor rather than a fixed ordering.
    const anchor = markup.match(/<a [^>]*>torre<\/a>/)?.[0] ?? "";
    expect(anchor).toContain('href="/orgs/torre"');
    expect(anchor).toContain('aria-current="page"');
    // It is not rendered as a bare, unclickable span.
    expect(markup).not.toContain('<span aria-current="page">torre</span>');
  });

  it("keeps the current item as plain text when it has no destination", () => {
    // Leaf page labels (e.g. `Guidance`) carry no `to`, so there is nothing
    // to link to — they stay a span flagged as the current page.
    const markup = renderTrail([{ label: "Home", to: "/" }, { label: "Guidance" }]);
    expect(markup).toMatch(/<span[^>]*aria-current="page"[^>]*>Guidance<\/span>/);
    expect(markup).not.toMatch(/<a[^>]*>Guidance<\/a>/);
  });

  it("still links every non-current item that has a destination", () => {
    const markup = renderTrail([
      { label: "Home", to: "/" },
      { label: "torre", to: "/orgs/torre" },
      { label: "meta-pull-requests", to: "/meta-pull-requests" },
    ]);
    expect(markup).toMatch(/<a[^>]*href="\/"[^>]*>Home<\/a>/);
    expect(markup).toMatch(/<a[^>]*href="\/orgs\/torre"[^>]*>torre<\/a>/);
  });
});
