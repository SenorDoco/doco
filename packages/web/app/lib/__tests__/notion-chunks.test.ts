import { describe, expect, it } from "vitest";
import { chunkSnippet, notionPageChunks } from "../notion-chunks";

describe("notionPageChunks", () => {
  it("makes one chunk per section, prefixed with the title and the headings above it", () => {
    const markdown = [
      "Intro line.",
      "# Q4 bets",
      "Ship the pie.",
      "## Pricing",
      "Run the experiment.",
      "# Q1",
      "Rest.",
    ].join("\n");

    expect(notionPageChunks("Roadmap", markdown)).toEqual([
      "Roadmap\n\nIntro line.",
      "Roadmap › Q4 bets\n\nShip the pie.",
      "Roadmap › Q4 bets › Pricing\n\nRun the experiment.",
      "Roadmap › Q1\n\nRest.",
    ]);
  });

  it("reads lists, tables, callouts, toggles, columns and child pages as text", () => {
    const markdown = [
      "- [ ] Laptop",
      "- [x] Badge",
      '<table header-row="true">',
      "\t<tr><td>Name</td><td>Status</td></tr>",
      "\t<tr><td>Ship it</td><td>Done</td></tr>",
      "</table>",
      '<callout icon="💡">',
      "\tAsk anything.",
      "</callout>",
      "<details><summary>More</summary>Hidden text</details>",
      "<columns>",
      "\t<column>Left</column>",
      "\t<column>Right</column>",
      "</columns>",
      "---",
      "<empty-block/>",
      '<page url="https://www.notion.so/abc">Onboarding</page>',
    ].join("\n");

    expect(notionPageChunks("Handbook", markdown)).toEqual([
      [
        "Handbook",
        "Laptop\nBadge",
        "Name | Status\nShip it | Done",
        "Ask anything.",
        "More\nHidden text",
        "Left\nRight",
        "Onboarding",
      ].join("\n\n"),
    ]);
  });

  it("splits a long section into windows that each carry the prefix", () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const chunks = notionPageChunks("Long", `# Body\n${words}`);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.startsWith("Long › Body\n\n")).toBe(true);
    expect(chunks[0]).toContain("word0 ");
    expect(chunks.at(-1)).toContain("word399");
  });

  it("falls back to the title for a page with no text", () => {
    expect(notionPageChunks("Empty", "")).toEqual(["Empty"]);
    expect(notionPageChunks("  ", "---")).toEqual(["Untitled"]);
  });
});

describe("chunkSnippet", () => {
  it("drops the path prefix and collapses whitespace", () => {
    expect(chunkSnippet("Roadmap › Q4\n\nShip  the\npie.")).toBe("Ship the pie.");
    expect(chunkSnippet("No prefix here")).toBe("No prefix here");
  });

  it("cuts a long chunk on a word boundary", () => {
    const body = Array.from({ length: 80 }, () => "lorem ipsum").join(" ");
    const snippet = chunkSnippet(`Title\n\n${body}`);

    expect(snippet.length).toBeLessThanOrEqual(301);
    expect(snippet).toMatch(/(lorem|ipsum)…$/);
  });
});
