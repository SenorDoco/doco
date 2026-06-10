import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import SearchInDoco from "../$docoHandle.search";

// VersionPill (rendered by SiteHeader) reads this build-time define.
beforeAll(() => {
  vi.stubGlobal("__DOCO_RELEASE_AT__", "2026-01-01T00:00:00.000Z");
  vi.stubGlobal("__DOCO_VERSION__", "0.0.0-test");
});

/**
 * The search page is a two-column layout: a left sidebar (`<aside>`) holds the
 * search box and the Types / Life-cycle facet filters, and the right column
 * holds the result list. This guards against the filters regressing back to a
 * full-width stack above the results.
 */
function renderSearch(): string {
  const loaderData = {
    q: "post a job",
    hits: [
      {
        id: "principal_01KT7NYEQ8MR0017DCHT02K8RD",
        node_type: "principal",
        lifecycle: "active",
        vector_score: 0.4013,
        gpr: 0.0011,
        created_at: new Date().toISOString(),
        name: "Public search results and ATS career sources",
        summary: "Public search results and ATS career sources",
      },
    ],
    warning: null,
    ownerSlug: "acme",
    docoSlug: "hiring",
    handle: "acme/hiring",
    host: {},
    me: null,
    filters: { lifecycle: ["active"], nodeType: null, limit: 100 },
    facets: {
      lifecycle: [{ value: "active", count: 11, updatedAt: null }],
      nodeType: [
        { value: "principal", count: 10, updatedAt: null },
        { value: "rule", count: 1, updatedAt: null },
      ],
      edgeType: [],
    },
    pagination: {
      page: 1,
      pageSize: 25,
      total: 11,
      totalPages: 1,
      start: 1,
      end: 11,
    },
  };

  const router = createMemoryRouter(
    [
      {
        path: "*",
        // biome-ignore lint/suspicious/noExplicitAny: test fixture stands in for loader output
        element: createElement(SearchInDoco, { loaderData: loaderData as any }),
      },
    ],
    { initialEntries: ["/acme/hiring/search?q=post+a+job"] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("SearchInDoco layout", () => {
  it("renders the search box and filters in a left sidebar, results in a second column", () => {
    const markup = renderSearch();

    // Two-column responsive grid wraps the sidebar + results.
    expect(markup).toMatch(/grid[^"]*md:grid-cols-/);

    // The first <aside> is the filter sidebar; nothing nests another, so the
    // first </aside> closes it.
    const aside = markup.match(/<aside[\s\S]*?<\/aside>/)?.[0] ?? "";
    expect(aside).toContain('name="q"');
    expect(aside).toContain("Types");
    expect(aside).toContain("Life cycles");
    // The results summary lives in the second column, not the sidebar.
    expect(aside).not.toContain("Showing");

    // Results still render.
    expect(markup).toContain("Showing");
  });
});
