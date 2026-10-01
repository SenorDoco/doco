import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import type { NotionIntegrationStatus } from "~/lib/integration-status.server";
import type {
  NotionPageSummary,
  NotionReaderPage,
  PagesView,
} from "~/lib/notion-mirror-read.server";
import { PagesReaderView } from "../pages-views";

const HB = "11111111-0000-4000-8000-000000000001";
const ONB = "11111111-0000-4000-8000-000000000002";
const notionUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;

const status: NotionIntegrationStatus = {
  integration: "notion",
  workspaceName: "Acme",
  latestAt: "2026-09-28T10:00:00.000Z",
  state: "done",
  needsReauth: false,
  pagesDone: 2,
  pages: 2,
  listingCapped: false,
};

function page(overrides: Partial<NotionReaderPage>): NotionReaderPage {
  return {
    pageId: ONB,
    object: "page",
    title: "Onboarding",
    icon: "👋",
    copied: true,
    url: notionUrl(ONB),
    path: [{ pageId: HB, title: "Handbook", icon: "📘", copied: true }],
    lastEditedAt: "2026-09-20T10:00:00.000Z",
    lastEditedBy: "Ana Ruiz",
    markdown: "",
    truncated: false,
    links: [],
    backlinks: [],
    ...overrides,
  };
}

function summary(overrides: Partial<NotionPageSummary>): NotionPageSummary {
  return {
    pageId: ONB,
    title: "Onboarding",
    icon: "👋",
    copied: true,
    object: "page",
    where: "Handbook",
    lastEditedAt: "2026-09-27T10:00:00.000Z",
    lastEditedBy: "Ana Ruiz",
    children: 0,
    ...overrides,
  };
}

function render(view: PagesView, source: NotionIntegrationStatus | null = status): string {
  const Stub = createRoutesStub([
    {
      path: "*",
      Component: () =>
        createElement(PagesReaderView, {
          handle: "acme-notion",
          view,
          status: source ?? { integration: "notion", state: "unconnected" },
        }),
    },
  ]);
  return renderToStaticMarkup(createElement(Stub, { initialEntries: ["/acme-notion/pages"] }));
}

describe("PagesReaderView home", () => {
  it("opens on the pages edited most recently and the top-level pages", () => {
    const html = render({
      view: "home",
      recent: [summary({})],
      top: [summary({ pageId: HB, title: "Handbook", icon: "📘", where: "", children: 2 })],
      trail: [],
    });
    expect(html).toContain("Recently edited");
    expect(html).toContain(`href="/acme-notion/pages/${ONB}"`);
    expect(html).toContain("Ana Ruiz");
    expect(html).toContain("Top-level pages");
    expect(html).toContain(`href="/acme-notion/pages/${HB}"`);
    expect(html).toContain("2 pages inside");
  });

  it("points a Doco that doesn't mirror Notion at the setup page", () => {
    const html = render({ view: "home", recent: [], top: [], trail: [] }, null);
    expect(html).toContain("No Notion workspace is connected");
    expect(html).toMatch(/href="\/acme-notion\/integrations\/notion"[^>]*>Connect Notion/);
  });

  it("says pages are on their way while the first copy runs", () => {
    const html = render(
      { view: "home", recent: [], top: [], trail: [] },
      { ...status, state: "importing", pagesDone: 0, pages: 0 },
    );
    expect(html).toContain("The pages shared with Doco in Notion appear here as they are copied.");
  });
});

describe("PagesReaderView page", () => {
  it("renders the page from its Markdown as elements, never as markup, linking mirrored pages within the reader", () => {
    const html = render({
      view: "page",
      page: page({
        markdown: [
          "# Before day one",
          "",
          `Start with <page url="${notionUrl(HB)}">Handbook</page>, then **read** <script>alert(1)</script>.`,
          "",
          "## Day one",
          "",
          "- [x] Badge",
          "",
          '<callout icon="💡">Ask around.</callout>',
        ].join("\n"),
        links: [{ pageId: HB, title: "Handbook", icon: "📘", copied: true }],
        backlinks: [{ pageId: HB, title: "Handbook", icon: "📘", copied: true }],
        truncated: true,
      }),
      trail: [HB, ONB],
    });

    expect(html).toMatch(/<h2[^>]*>(?:(?!<\/h2>).)*Onboarding<\/h2>/);
    expect(html).toContain('id="before-day-one"');
    expect(html).toContain(`href="/acme-notion/pages/${HB}"`);
    expect(html).toContain("<strong>read</strong>");
    expect(html).not.toContain("<script");
    expect(html).toContain("alert(1)");
    expect(html).toContain('checked=""');
    expect(html).toContain("Ask around.");
    expect(html).toContain("ends early");
    expect(html).toContain(`href="${notionUrl(ONB)}"`);
    expect(html).toContain("by Ana Ruiz");
    // Beside the page: its outline and its links.
    expect(html).toContain("On this page");
    expect(html).toContain('href="#before-day-one"');
    expect(html).toContain('href="#day-one"');
    expect(html).toContain("Linked from");
    expect(html).toContain("Links to");
  });

  it("marks a queued child page, and a page the copy lacks, next to their links", () => {
    const GONE = "11111111-0000-4000-8000-000000000009";
    const html = render({
      view: "page",
      page: page({
        markdown: [
          `<page url="${notionUrl(HB)}">Handbook</page>`,
          `<page url="${notionUrl(GONE)}">Elsewhere</page>`,
        ].join("\n"),
        links: [{ pageId: HB, title: "Handbook", icon: null, copied: false }],
      }),
      trail: [HB, ONB],
    });

    expect(html).toContain(`href="/acme-notion/pages/${HB}"`);
    expect(html).toContain("not copied yet</span>");
    expect(html).toContain(`href="${notionUrl(GONE)}"`);
    expect(html).toContain("not copied yet · opens in Notion");
  });

  it("explains a page that is not copied yet instead of showing an empty copy", () => {
    const html = render({
      view: "page",
      page: page({ copied: false, markdown: "" }),
      trail: [HB, ONB],
    });
    expect(html).toContain("This page is not in the copy yet");
    expect(html).toContain(`href="${notionUrl(ONB)}"`);
  });
});

describe("PagesReaderView search", () => {
  it("shows each hit with where it lives and the text that matched", () => {
    const html = render({
      view: "search",
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
      trail: [],
    });
    expect(html).toContain("Day one: <mark>Laptop</mark> Badge");
    expect(html).toContain("Handbook");
    expect(html).toContain(`href="/acme-notion/pages/${ONB}"`);
  });

  it("says when a hit is not copied yet, and when nothing matches", () => {
    const html = render({
      view: "search",
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
      trail: [],
    });
    expect(html).toContain("Not copied yet");
    expect(html).toContain("read it in Notion");
    expect(render({ view: "search", query: "zzz", hits: [], trail: [] })).toContain(
      "No pages match “zzz”.",
    );
  });
});
