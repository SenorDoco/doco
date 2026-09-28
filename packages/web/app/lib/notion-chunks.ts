// What of a mirrored Notion page gets embedded: its text, one section per
// heading, each chunk prefixed with the page title and the headings above it
// (`Roadmap › Q4 bets › Pricing`), so a passage about "the experiment" is
// found by a query about pricing. A database row's property line is already
// the first line of its text; a data source's schema is one section. Pure.
import { chunkText } from "@doco/db";
import { type NotionBlock, inlineText, parseNotionMarkdown } from "./notion-markdown-blocks";

const SNIPPET_CHARS = 300;

export function notionPageChunks(title: string, markdown: string): string[] {
  const pageTitle = title.trim() || "Untitled";
  const chunks: string[] = [];
  const headings: string[] = [];
  let section: string[] = [];
  const flush = () => {
    const text = section.join("\n\n").trim();
    section = [];
    if (!text) return;
    const prefix = [pageTitle, ...headings].join(" › ");
    for (const chunk of chunkText(text)) chunks.push(`${prefix}\n\n${chunk}`);
  };
  for (const block of parseNotionMarkdown(markdown)) {
    if (block.type === "heading") {
      flush();
      headings.length = Math.min(headings.length, block.level - 1);
      headings.push(inlineText(block.children).trim());
      continue;
    }
    const text = blockText(block);
    if (text) section.push(text);
  }
  flush();
  return chunks.length > 0 ? chunks : [pageTitle];
}

/** The chunk's own text, its path prefix dropped, cut to snippet length. */
export function chunkSnippet(chunk: string): string {
  const at = chunk.indexOf("\n\n");
  const body = (at === -1 ? chunk : chunk.slice(at + 2)).replace(/\s+/g, " ").trim();
  if (body.length <= SNIPPET_CHARS) return body;
  const cut = body.lastIndexOf(" ", SNIPPET_CHARS);
  return `${body.slice(0, cut > SNIPPET_CHARS / 2 ? cut : SNIPPET_CHARS).trim()}…`;
}

function blockText(block: NotionBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return inlineText(block.children).trim();
    case "list":
      return block.items
        .map((item) => item.children.map(blockText).filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n");
    case "code":
    case "equation":
      return block.text.trim();
    case "quote":
    case "callout":
      return block.children.map(blockText).filter(Boolean).join("\n");
    case "details":
      return [inlineText(block.summary), ...block.children.map(blockText)]
        .filter(Boolean)
        .join("\n");
    case "columns":
      return block.columns
        .map((column) => column.map(blockText).filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n");
    case "table": {
      const rows = block.header.length > 0 ? [block.header, ...block.rows] : block.rows;
      return rows.map((row) => row.map((cell) => inlineText(cell).trim()).join(" | ")).join("\n");
    }
    case "child":
      return block.title.trim();
    case "file":
      return block.label === block.kind ? "" : block.label.trim();
    case "rule":
    case "unknown":
      return "";
  }
}
