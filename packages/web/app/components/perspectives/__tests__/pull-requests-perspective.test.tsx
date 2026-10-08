import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type { PullRequestsPerspectiveData } from "~/lib/pull-requests-perspective.server";
import { PullRequestsPerspective } from "../pull-requests-perspective";

const pr = {
  id: "reference_1",
  title: "Cap the lists",
  url: "https://github.com/acme/web/pull/1",
  lifecycle: "active",
  label: "Merged",
  updatedAt: "2026-10-08T00:00:00.000Z",
};

const base: PullRequestsPerspectiveData = {
  connected: true,
  items: [pr],
  loadedCount: 1,
  totalCount: 1,
  hasMore: false,
};

function render(data: PullRequestsPerspectiveData, url = "/"): string {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => createElement(PullRequestsPerspective, { data, handle: "acme" }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: [url] }));
}

describe("PullRequestsPerspective", () => {
  it("shows every pull request when they fit", () => {
    const html = render(base);
    expect(html).toContain("Cap the lists");
    expect(html).not.toContain("Show more");
  });

  it("offers Show more after the latest 50, keeping the stage filter", () => {
    const html = render(
      { ...base, loadedCount: 50, totalCount: 1203, hasMore: true },
      "/?perspective=pull-requests&pr_lifecycle=active",
    );
    expect(html).toContain("Showing the latest 50 of 1,203 pull requests");
    expect(html).toContain("Show more");
    expect(html).toContain(
      'href="/?perspective=pull-requests&amp;pr_lifecycle=active&amp;pr_limit=100"',
    );
  });
});
