// Notion's enhanced Markdown parsed into the block tree the reader renders:
// one block per line, tab-indented children, Notion's tags, and the
// guarantee that a page's text never becomes markup.
import { describe, expect, it } from "vitest";
import { inlineText, parseInline, parseNotionMarkdown } from "../notion-markdown-blocks";

const text = (value: string) => ({ type: "text" as const, text: value });
const paragraph = (value: string) => ({ type: "paragraph" as const, children: [text(value)] });

describe("parseNotionMarkdown", () => {
  it("parses headings, dropping Notion's attributes and capping the depth", () => {
    expect(parseNotionMarkdown('# Title {color="red"}\n## Sub {toggle="true"}\n#### Deep')).toEqual(
      [
        { type: "heading", level: 1, children: [text("Title")] },
        { type: "heading", level: 2, children: [text("Sub")] },
        { type: "heading", level: 3, children: [text("Deep")] },
      ],
    );
  });

  it("reads one block per line, with <br> as the line break inside a block", () => {
    expect(parseNotionMarkdown('one<br>two {color="blue"}\nthree')).toEqual([
      { type: "paragraph", children: [text("one"), { type: "break" }, text("two")] },
      paragraph("three"),
    ]);
  });

  it("nests tab-indented children, reads to-do boxes, and keeps numbered lists apart", () => {
    expect(
      parseNotionMarkdown(
        '- [ ] Laptop\n- [x] Badge {color="red"}\n\t- nested\n\t\tmore of nested\n1. first\n2. second',
      ),
    ).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          { checked: false, children: [paragraph("Laptop")] },
          {
            checked: true,
            children: [
              paragraph("Badge"),
              {
                type: "list",
                ordered: false,
                items: [
                  { checked: null, children: [paragraph("nested"), paragraph("more of nested")] },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "list",
        ordered: true,
        items: [
          { checked: null, children: [paragraph("first")] },
          { checked: null, children: [paragraph("second")] },
        ],
      },
    ]);
  });

  it("parses fenced code, quotes, rules and equations", () => {
    expect(
      parseNotionMarkdown(
        '```ts\nconst a = 1;\n```\n> quoted<br>more {color="gray"}\n---\n$$E = mc^2$$',
      ),
    ).toEqual([
      { type: "code", language: "ts", text: "const a = 1;" },
      {
        type: "quote",
        children: [
          { type: "paragraph", children: [text("quoted"), { type: "break" }, text("more")] },
        ],
      },
      { type: "rule" },
      { type: "equation", text: "E = mc^2" },
    ]);
  });

  it("parses tables from their rows and cells, the first row a header when the table says so", () => {
    expect(
      parseNotionMarkdown(
        '<table header-row="true" fit-page-width="false">\n\t<tr><td>A</td><td>B</td></tr>\n\t<tr color="gray_bg"><td>1</td><td>**2**</td></tr>\n</table>\n<table>\n\t<tr><td>x</td></tr>\n</table>',
      ),
    ).toEqual([
      {
        type: "table",
        header: [[text("A")], [text("B")]],
        rows: [[[text("1")], [{ type: "strong", children: [text("2")] }]]],
      },
      { type: "table", header: [], rows: [[[text("x")]]] },
    ]);
  });

  it("parses callouts, toggles and columns, with their contents as blocks", () => {
    expect(
      parseNotionMarkdown(
        [
          '<callout icon="💡" color="gray_bg">',
          '\tAsk <mention-user url="https://www.notion.so/u1">Ana</mention-user> anything.',
          "</callout>",
          '<details color="blue"><summary>More</summary>Hidden text</details>',
          "<columns>",
          "\t<column>Left</column>",
          "\t<column>Right</column>",
          "</columns>",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "callout",
        icon: "💡",
        children: [
          {
            type: "paragraph",
            children: [text("Ask "), { type: "user", name: "Ana" }, text(" anything.")],
          },
        ],
      },
      { type: "details", summary: [text("More")], children: [paragraph("Hidden text")] },
      { type: "columns", columns: [[paragraph("Left")], [paragraph("Right")]] },
    ]);
  });

  it("reads child pages, databases, files, empty lines, and blocks Notion could not render", () => {
    expect(
      parseNotionMarkdown(
        [
          '<page url="https://www.notion.so/abc" color="default">Onboarding</page>',
          '<database url="https://www.notion.so/def" inline="true" icon="📋">Tasks</database>',
          '<file src="https://prod-files-secure.s3.us-west-2.amazonaws.com/x/plan.pdf">plan.pdf</file>',
          "<empty-block/>",
          '<unknown url="https://www.notion.so/ghi" alt="bookmark"/>',
          '<table_of_contents color="gray"/>',
        ].join("\n"),
      ),
    ).toEqual([
      { type: "child", kind: "page", href: "https://www.notion.so/abc", title: "Onboarding" },
      { type: "child", kind: "database", href: "https://www.notion.so/def", title: "Tasks" },
      {
        type: "file",
        kind: "file",
        src: "https://prod-files-secure.s3.us-west-2.amazonaws.com/x/plan.pdf",
        label: "plan.pdf",
      },
      { type: "unknown", href: "https://www.notion.so/ghi", alt: "bookmark" },
    ]);
  });

  it("runs an unterminated container to the end of the page", () => {
    expect(parseNotionMarkdown("<callout>\nText")).toEqual([
      { type: "callout", icon: null, children: [paragraph("Text")] },
    ]);
  });
});

describe("parseInline", () => {
  it("parses emphasis, code, links, images, citations, spans and mentions", () => {
    expect(
      parseInline(
        '**bold** *em* ~~gone~~ `code` [link](https://doco.to) ![Diagram](https://x.test/d.png) <mention-page url="https://www.notion.so/abc">Handbook</mention-page> due <mention-date start="2026-10-01" end="2026-10-03"/> [^https://x.test/src] <span underline="true">under</span> <span color="red">red</span> $x^2$',
      ),
    ).toEqual([
      { type: "strong", children: [text("bold")] },
      text(" "),
      { type: "em", children: [text("em")] },
      text(" "),
      { type: "strike", children: [text("gone")] },
      text(" "),
      { type: "code", text: "code" },
      text(" "),
      { type: "link", href: "https://doco.to", children: [text("link")] },
      text(" "),
      { type: "image", src: "https://x.test/d.png", alt: "Diagram" },
      text(" "),
      { type: "mention", href: "https://www.notion.so/abc", label: "Handbook" },
      text(" due "),
      { type: "date", start: "2026-10-01", end: "2026-10-03" },
      text(" "),
      { type: "link", href: "https://x.test/src", children: [text("[source]")] },
      text(" "),
      { type: "underline", children: [text("under")] },
      text(" "),
      text("red"),
      text(" "),
      { type: "code", text: "x^2" },
    ]);
  });

  it("reads self-closing user and page mentions", () => {
    expect(
      parseInline(
        '<mention-user url="https://www.notion.so/u1"/> and <mention-page url="https://www.notion.so/p1"/>',
      ),
    ).toEqual([
      { type: "user", name: "someone" },
      text(" and "),
      { type: "mention", href: "https://www.notion.so/p1", label: "https://www.notion.so/p1" },
    ]);
  });

  it("leaves underscores inside words, lone marks, and escapes as text", () => {
    expect(parseInline("snake_case a*b \\*not em\\* 3 &amp; 4 \\^")).toEqual([
      text("snake_case a*b *not em* 3 & 4 ^"),
    ]);
  });

  it("renders a tag it doesn't know as its contents, and drops markup outright", () => {
    expect(
      parseInline("<script>alert(1)</script> <img src=x onerror=alert(1)> <mark>hi</mark>"),
    ).toEqual([text("alert(1)"), text(" "), text(" "), text("hi")]);
  });
});

describe("inlineText", () => {
  it("joins the text of a run of inlines, marks dropped", () => {
    expect(
      inlineText(parseInline('**a** [b](https://x.test) <mention-user url="u">Ana</mention-user>')),
    ).toBe("a b @Ana");
  });
});
