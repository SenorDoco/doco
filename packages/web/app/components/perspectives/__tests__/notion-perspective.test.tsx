import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type { NotionPerspectiveData, NotionReaderPage } from "~/lib/notion-mirror-read.server";
import { NotionPerspective } from "../notion-perspective";

const HB = "11111111-0000-4000-8000-000000000001";
const ONB = "11111111-0000-4000-8000-000000000002";
const notionUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;

function page(overrides: Partial<NotionReaderPage>): NotionReaderPage {
  return {
    pageId: HB,
    object: "page",
    title: "Handbook",
    icon: "📘",
    copied: true,
    url: notionUrl(HB),
    path: [],
    lastEditedAt: "2026-09-20T10:00:00.000Z",
    lastEditedBy: "Ana Ruiz",
    markdown: "",
    truncated: false,
    links: [],
    backlinks: [],
    ...overrides,
  };
}

const base: NotionPerspectiveData = {
  workspaceName: "Acme",
  pages: 2,
  tree: [
    {
      pageId: HB,
      title: "Handbook",
      icon: "📘",
      copied: true,
      object: "page",
      hasChildren: true,
      more: 0,
      children: [
        {
          pageId: ONB,
          title: "Onboarding",
          icon: null,
          copied: true,
          object: "page",
          hasChildren: false,
          children: null,
          more: 0,
        },
      ],
    },
  ],
  moreRoots: 0,
  page: page({}),
  query: "",
  hits: [],
};

function render(data: NotionPerspectiveData): string {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => createElement(NotionPerspective, { data, handle: "acme-notion" }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub));
}

describe("NotionPerspective", () => {
  it("points a Doco that doesn't mirror Notion at the setup page", () => {
    const html = render({ ...base, workspaceName: null, tree: [], page: null });
    expect(html).toContain('href="/acme-notion/integrations/notion"');
  });

  it("lists the page tree as links that keep the Notion perspective open", () => {
    const html = render(base);
    expect(html).toContain(`href="/?perspective=notion&amp;notion_page=${ONB}"`);
    expect(html).toContain("Onboarding");
  });

  it("renders the page from its Markdown as elements, never as markup, linking mirrored pages within the reader", () => {
    const html = render({
      ...base,
      page: page({
        markdown: [
          "# Welcome",
          "",
          `Start with <page url="${notionUrl(ONB)}">Onboarding</page>, then **read** <script>alert(1)</script>.`,
          "",
          "- [x] Badge",
          "",
          '<callout icon="💡">Ask around.</callout>',
        ].join("\n"),
        links: [{ pageId: ONB, title: "Onboarding", icon: null, copied: true }],
        backlinks: [{ pageId: ONB, title: "Onboarding", icon: null, copied: true }],
        truncated: true,
      }),
    });

    expect(html).toContain('<h2 class="mt-4 text-lg font-semibold">Welcome</h2>');
    expect(html).toContain(`href="/?perspective=notion&amp;notion_page=${ONB}" data-discover`);
    expect(html).toContain("<strong>read</strong>");
    expect(html).not.toContain("<script");
    expect(html).toContain("alert(1)");
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain('checked=""');
    expect(html).toContain("Ask around.");
    expect(html).toContain("Linked from");
    expect(html).toContain("ends early");
    expect(html).toContain(`href="${notionUrl(HB)}"`);
    expect(html).toContain("by Ana Ruiz");
  });

  it("marks a queued child page, and a page the copy lacks, next to their links", () => {
    const GONE = "11111111-0000-4000-8000-000000000009";
    const html = render({
      ...base,
      page: page({
        markdown: [
          `<page url="${notionUrl(ONB)}">Onboarding</page>`,
          `<page url="${notionUrl(GONE)}">Elsewhere</page>`,
          `See <mention-page url="${notionUrl(GONE)}">elsewhere</mention-page>.`,
        ].join("\n"),
        links: [{ pageId: ONB, title: "Onboarding", icon: null, copied: false }],
      }),
    });

    expect(html).toContain(`href="/?perspective=notion&amp;notion_page=${ONB}"`);
    expect(html).toContain("not copied yet</span>");
    expect(html).toContain(`href="${notionUrl(GONE)}"`);
    expect(html).toContain("not copied yet · opens in Notion");
    expect(html).toContain('title="Not in the copy yet: opens in Notion"');
  });

  it("explains a page that is not copied yet instead of showing an empty copy", () => {
    const html = render({
      ...base,
      tree: [{ ...base.tree[0], copied: false }],
      page: page({ copied: false, markdown: "" }),
    });

    expect(html).toContain("This page is not in the copy yet");
    expect(html).toContain(`href="${notionUrl(HB)}"`);
    expect(html).toContain('title="Not copied yet"');
  });

  it("says when a search hit is not copied yet", () => {
    const html = render({
      ...base,
      page: null,
      query: "laptop",
      hits: [
        {
          type: "notion_page",
          page_id: ONB,
          title: "Onboarding",
          path: "",
          url: notionUrl(ONB),
          last_edited_time: null,
          snippet: "",
          copied: false,
        },
      ],
    });

    expect(html).toContain("Not copied yet");
    expect(html).toContain("read it in Notion");
  });

  it("shows search hits with their path and snippet", () => {
    const html = render({
      ...base,
      page: null,
      query: "laptop",
      hits: [
        {
          type: "notion_page",
          page_id: ONB,
          title: "Onboarding",
          path: "Handbook",
          url: notionUrl(ONB),
          last_edited_time: null,
          snippet: "Day one: Laptop Badge",
          copied: true,
        },
      ],
    });

    expect(html).toContain('value="laptop"');
    expect(html).toContain("Day one: Laptop Badge");
    expect(html).toContain(">Handbook</span>");
    expect(html).toContain(`href="/?perspective=notion&amp;notion_page=${ONB}"`);
  });
});
