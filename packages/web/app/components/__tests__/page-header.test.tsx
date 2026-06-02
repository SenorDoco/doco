import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { PageHeader } from "../page-header";

function render(props: Parameters<typeof PageHeader>[0]): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PageHeader, props)));
}

describe("PageHeader", () => {
  it("renders the title at the shared, large font size", () => {
    // Every page title uses one shared, larger size — never the old text-lg.
    const html = render({ title: "acctest" });
    expect(html).toMatch(/<h1[^>]*class="[^"]*text-2xl[^"]*"[^>]*>acctest<\/h1>/);
    expect(html).not.toContain("text-lg");
  });

  it("renders the fishbone breadcrumb above the title", () => {
    const html = render({
      breadcrumb: [{ label: "Home", to: "/" }, { label: "acctest" }],
      title: "acctest",
    });
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain("Home");
    // The breadcrumb (fishbone) sits above the title.
    expect(html.indexOf('aria-label="Breadcrumb"')).toBeLessThan(html.indexOf("<h1"));
  });

  it("places action buttons to the right of the title on the same row", () => {
    const html = render({
      title: "acctest",
      actions: createElement("a", { href: "/x/settings" }, "Settings"),
    });
    // The title row is a justify-between flex so actions sit beside the title.
    expect(html).toContain("justify-between");
    // Actions render after the title in source order — to its right.
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("Settings"));
  });

  it("renders description content beneath the title row", () => {
    const html = render({
      title: "acctest",
      children: createElement("p", null, "a short goal"),
    });
    expect(html).toContain("a short goal");
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("a short goal"));
  });
});
