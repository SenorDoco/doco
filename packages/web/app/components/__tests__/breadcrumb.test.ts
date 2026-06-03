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

// Render the trail as if the browser were at `path`, so the component's
// current-location self-link resolves to that page.
function renderTrailAt(items: BreadcrumbItem[], path: string): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(Breadcrumb, { items })),
  );
}

describe("docoBreadcrumb", () => {
  it("keeps Home and the owning workspace in doco-scoped trails", () => {
    expect(docoBreadcrumb({ ownerSlug: "torre", handle: "meta-pull-requests" })).toEqual([
      { label: "Home", to: "/" },
      { label: "torre", to: "/workspaces/torre" },
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
      { label: "torre", to: "/workspaces/torre" },
      { label: "meta-pull-requests", to: "/meta-pull-requests" },
      { label: "Policies", to: "/meta-pull-requests/policies" },
      { label: "Guidance" },
    ]);
  });
});

describe("Breadcrumb rendering", () => {
  it("renders the current (last) item as a link when it has a destination", () => {
    // The screenshot case: on /workspaces/torre the trail is `Workspaces › torre` and
    // `torre` is the current page but still has a `to`. It must be clickable.
    const markup = renderTrail([
      { label: "Workspaces", to: "/workspaces" },
      { label: "torre", to: "/workspaces/torre" },
    ]);
    // The current item is an anchor to its own page, still flagged as current.
    // Attribute order in the rendered <a> isn't guaranteed, so assert on the
    // extracted anchor rather than a fixed ordering.
    const anchor = markup.match(/<a [^>]*>torre<\/a>/)?.[0] ?? "";
    expect(anchor).toContain('href="/workspaces/torre"');
    expect(anchor).toContain('aria-current="page"');
    // It is not rendered as a bare, unclickable span.
    expect(markup).not.toContain('<span aria-current="page">torre</span>');
  });

  it("self-links the current item to the current page when it has no destination", () => {
    // Leaf page labels (e.g. `Tokens/MCP` on /tokens) carry no `to`, but
    // the current crumb must still be clickable everywhere — it self-links to
    // the page you are already on.
    const markup = renderTrailAt([{ label: "Home", to: "/" }, { label: "Tokens/MCP" }], "/tokens");
    const anchor = markup.match(/<a [^>]*>Tokens\/MCP<\/a>/)?.[0] ?? "";
    expect(anchor).toContain('href="/tokens"');
    expect(anchor).toContain('aria-current="page"');
    // It is no longer a bare, unclickable span.
    expect(markup).not.toContain('<span aria-current="page">Tokens/MCP</span>');
  });

  it("only self-links the current item — earlier crumbs without a destination stay text", () => {
    // A middle crumb with no `to` has no natural target, so it stays plain
    // text; only the trailing (current) crumb gets the current-path fallback.
    const markup = renderTrailAt(
      [{ label: "Home", to: "/" }, { label: "Section" }, { label: "Leaf", to: "/leaf" }],
      "/leaf",
    );
    expect(markup).toMatch(/<span[^>]*>Section<\/span>/);
    expect(markup).not.toMatch(/<a[^>]*>Section<\/a>/);
  });

  it("still links every non-current item that has a destination", () => {
    const markup = renderTrail([
      { label: "Home", to: "/" },
      { label: "torre", to: "/workspaces/torre" },
      { label: "meta-pull-requests", to: "/meta-pull-requests" },
    ]);
    expect(markup).toMatch(/<a[^>]*href="\/"[^>]*>Home<\/a>/);
    expect(markup).toMatch(/<a[^>]*href="\/workspaces\/torre"[^>]*>torre<\/a>/);
  });
});
