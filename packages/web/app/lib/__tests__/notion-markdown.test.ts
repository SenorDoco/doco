import { describe, expect, it } from "vitest";
import {
  flattenNotionProperties,
  normalizeNotionId,
  normalizeNotionMarkdown,
  notionChildRefs,
  notionIconToString,
  notionIdFromUrl,
  notionLinkedIds,
  notionPageUrl,
  notionPlainText,
  notionRichTextToPlain,
  renderNotionProperties,
} from "../notion-markdown";

const ID = "153104cd-477e-809d-8dc4-ff2d96ae3090";
const HEX = "153104cd477e809d8dc4ff2d96ae3090";

describe("Notion ids and URLs", () => {
  it("normalizes dashed and bare ids, and rejects anything else", () => {
    expect(normalizeNotionId(ID)).toBe(ID);
    expect(normalizeNotionId(HEX)).toBe(ID);
    expect(normalizeNotionId(HEX.toUpperCase())).toBe(ID);
    expect(normalizeNotionId("not-an-id")).toBeNull();
    expect(normalizeNotionId(undefined)).toBeNull();
  });

  it("links a page by its bare id, stable across renames", () => {
    expect(notionPageUrl(ID)).toBe(`https://www.notion.so/${HEX}`);
  });

  it.each([
    [`https://www.notion.so/acme/Pricing-experiment-${HEX}`, ID],
    [`https://www.notion.so/${HEX}?pvs=4`, ID],
    [`https://acme.notion.site/Roadmap-${HEX}`, ID],
    [`https://www.notion.so/acme/Parent-0000000000000000000000000000abcd?p=${HEX}`, ID],
    ["https://example.com/page", null],
    ["not a url", null],
  ])("reads the id out of %s", (url, expected) => {
    expect(notionIdFromUrl(url)).toBe(expected);
  });
});

describe("normalizeNotionMarkdown", () => {
  it("strips the signed query of Notion-hosted files so an unchanged page hashes the same", () => {
    const signed =
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/f1/chart.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc&X-Amz-Signature=deadbeef";
    const notionFile =
      "https://file.notion.so/f/f/ws/f1/deck.pdf?table=block&id=b1&expirationTimestamp=1700000000&signature=abc";
    const out = normalizeNotionMarkdown(
      `![Chart](${signed})\n<pdf src="${notionFile}">Deck</pdf>\r\n`,
    );
    expect(out).toBe(
      '![Chart](https://prod-files-secure.s3.us-west-2.amazonaws.com/ws/f1/chart.png)\n<pdf src="https://file.notion.so/f/f/ws/f1/deck.pdf">Deck</pdf>',
    );
  });

  it("leaves other links, including ones with queries, alone", () => {
    const md = "See [the dashboard](https://example.com/report?tab=q4&view=all).";
    expect(normalizeNotionMarkdown(md)).toBe(md);
  });
});

describe("notionPlainText", () => {
  it("keeps the words and drops the syntax", () => {
    const md = [
      '# Pricing experiment {color="red"}',
      "",
      "We chose **annual** plans, see [the analysis](https://example.com/a) and ![funnel](https://x/y.png).",
      "",
      "- [x] Ship the page",
      '- Tell <mention-user url="https://www.notion.so/u1">Tania</mention-user> by <mention-date start="2026-10-01" end="2026-10-03"/>',
      "1. First",
      "> quoted `code`",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      '<callout icon="💡" color="blue">Remember the <page url="https://www.notion.so/Roadmap-' +
        "153104cd477e809d8dc4ff2d96ae3090" +
        '">Roadmap</page></callout>',
      '<unknown url="https://www.notion.so/x" alt="unsupported"/>',
      "$$E = mc^2$$",
    ].join("\n");
    expect(notionPlainText(md)).toBe(
      [
        "Pricing experiment",
        "",
        "We chose annual plans, see the analysis and funnel.",
        "",
        "Ship the page",
        "Tell Tania by 2026-10-01 to 2026-10-03",
        "First",
        "quoted code",
        "",
        "const x = 1;",
        "",
        "Remember the Roadmap",
        "",
        "E = mc^2",
      ].join("\n"),
    );
  });
});

describe("notionLinkedIds", () => {
  it("collects child pages, mentions, databases and plain notion.so links once each", () => {
    const md = [
      `<page url="https://www.notion.so/Child-${HEX}">Child</page>`,
      `<mention-page url="https://www.notion.so/${HEX}">Child again</mention-page>`,
      '<database url="https://www.notion.so/00000000000000000000000000000001" inline="true">Tasks</database>',
      "[elsewhere](https://example.com/x) and [a page](https://www.notion.so/00000000000000000000000000000002?pvs=4)",
      '<mention-user url="https://www.notion.so/u1">Tania</mention-user>',
    ].join("\n");
    expect(notionLinkedIds(md)).toEqual([
      ID,
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ]);
  });
});

describe("properties", () => {
  const properties = {
    Name: { type: "title", title: [{ plain_text: "Pricing " }, { plain_text: "experiment" }] },
    Status: { type: "status", status: { name: "Done", color: "green" } },
    Owner: { type: "people", people: [{ id: "u1", name: "Tania" }, { id: "u2" }] },
    Tags: { type: "multi_select", multi_select: [{ name: "growth" }, { name: "q4" }] },
    Due: { type: "date", date: { start: "2026-10-01", end: "2026-10-03" } },
    Effort: { type: "number", number: 3 },
    Shipped: { type: "checkbox", checkbox: true },
    Spec: { type: "url", url: "https://example.com/spec" },
    Related: { type: "relation", relation: [{ id: "p1" }], has_more: false },
    Score: { type: "formula", formula: { type: "number", number: 42 } },
    Ticket: { type: "unique_id", unique_id: { prefix: "TASK", number: 7 } },
    Notes: { type: "rich_text", rich_text: [] },
    Empty: { type: "select", select: null },
    Button: { type: "button", button: {} },
  };

  it("flattens values to plain strings, numbers, booleans and lists", () => {
    expect(flattenNotionProperties(properties)).toEqual({
      Name: "Pricing experiment",
      Status: "Done",
      Owner: ["Tania", "u2"],
      Tags: ["growth", "q4"],
      Due: "2026-10-01 to 2026-10-03",
      Effort: 3,
      Shipped: true,
      Spec: "https://example.com/spec",
      Related: ["p1"],
      Score: 42,
      Ticket: "TASK-7",
    });
  });

  it("renders the property block a row's text opens with", () => {
    expect(renderNotionProperties({ Status: "Done", Owner: ["Tania", "Ben"], Effort: 3 })).toBe(
      "**Status:** Done · **Owner:** Tania, Ben · **Effort:** 3",
    );
    expect(renderNotionProperties({})).toBe("");
  });

  it("reads rich text and icons", () => {
    expect(notionRichTextToPlain([{ plain_text: "a" }, { plain_text: "b" }])).toBe("ab");
    expect(notionRichTextToPlain(null)).toBe("");
    expect(notionIconToString({ type: "emoji", emoji: "📘" })).toBe("📘");
    expect(
      notionIconToString({
        type: "file",
        file: { url: "https://file.notion.so/f/icon.png?expirationTimestamp=1&signature=s" },
      }),
    ).toBe("https://file.notion.so/f/icon.png");
    expect(notionIconToString(null)).toBeNull();
  });
});

describe("notionChildRefs", () => {
  const childUrl = (id: string) => `https://www.notion.so/${id.replace(/-/g, "")}`;
  const A = "00000000-0000-0000-0000-00000000000a";
  const B = "00000000-0000-0000-0000-00000000000b";
  const D = "00000000-0000-0000-0000-00000000000d";

  it("lists the child pages and databases once each, titled as the parent shows them", () => {
    const md = [
      `Intro with <mention-page url="${childUrl(ID)}">a mention</mention-page> and [a link](${childUrl(ID)}).`,
      `<page url="${childUrl(A)}" color="default">**Manifesto**</page>`,
      `<database url="${childUrl(D)}" inline="true" icon="📋">Tasks</database>`,
      `<page url="${childUrl(A)}">Manifesto again</page>`,
      `<child-page url="${childUrl(B)}"/>`,
      '<page url="https://example.com/not-notion">Elsewhere</page>',
    ].join("\n");

    expect(notionChildRefs(md)).toEqual([
      { id: A, kind: "page", title: "Manifesto" },
      { id: D, kind: "database", title: "Tasks" },
      { id: B, kind: "page", title: "" },
    ]);
  });
});

describe("notionIdFromUrl on Notion's own hosts", () => {
  it("reads the id from app.notion.com, www.notion.com and notion.so URLs alike", () => {
    expect(notionIdFromUrl(`https://app.notion.com/p/Avocado-${HEX}`)).toBe(ID);
    expect(notionIdFromUrl(`https://www.notion.com/${HEX}?pvs=4`)).toBe(ID);
    expect(notionIdFromUrl(`https://www.notion.so/Avocado-${HEX}`)).toBe(ID);
    expect(notionIdFromUrl(`https://example.com/p/Avocado-${HEX}`)).toBeNull();
  });
});
