// Notion's enhanced Markdown, parsed into a block tree. The reader renders
// the tree as React elements, so a page's text is only ever text: nothing in
// a page becomes HTML. The format (developers.notion.com, "Enhanced markdown
// format"): one block per line, `<br>` for a line break inside one, children
// tab-indented under their parent, a trailing `{color="…"}` attribute list
// for block colors, Markdown for what Markdown has syntax for, and XML-like
// tags for the rest (callouts, toggles, columns, tables, mentions, files).
// A tag this parser doesn't know renders as its contents.
//
// The same parser reads the Markdown files of a codebase as GitHub writes
// them (parseGitHubMarkdown): a paragraph runs over several lines, tables
// are pipes, and HTML comments say nothing. Pure.

export type NotionInline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "strike" | "underline"; children: NotionInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: NotionInline[] }
  | { type: "image"; src: string; alt: string }
  /** A page, database, data source or agent mention, by its Notion URL. */
  | { type: "mention"; href: string; label: string }
  | { type: "user"; name: string }
  | { type: "date"; start: string; end: string | null }
  | { type: "break" };

export interface NotionListItem {
  /** true or false for a to-do, null for a plain item. */
  checked: boolean | null;
  children: NotionBlock[];
}

export type NotionBlock =
  | { type: "heading"; level: 1 | 2 | 3; children: NotionInline[] }
  | { type: "paragraph"; children: NotionInline[] }
  | { type: "list"; ordered: boolean; items: NotionListItem[] }
  | { type: "code"; language: string; text: string }
  | { type: "equation"; text: string }
  | { type: "quote"; children: NotionBlock[] }
  | { type: "rule" }
  /** `header` is empty when the table has no header row. */
  | { type: "table"; header: NotionInline[][]; rows: NotionInline[][][] }
  | { type: "callout"; icon: string | null; children: NotionBlock[] }
  | { type: "details"; summary: NotionInline[]; children: NotionBlock[] }
  | { type: "columns"; columns: NotionBlock[][] }
  /** A child page or database, by its Notion URL. */
  | { type: "child"; kind: "page" | "database"; href: string; title: string }
  /** A file or a piece of media, linked by `src` when it has one. */
  | { type: "file"; kind: string; src: string | null; label: string }
  /** A block Notion could not render: `alt` names its type. */
  | { type: "unknown"; href: string | null; alt: string };

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^`~\s]*)/;
const HEADING_RE = /^[ \t]*(#{1,6})[ \t]+(.*?)[ \t]*$/;
const RULE_RE = /^[ \t]*([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE_RE = /^[ \t]*>[ \t]?/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(?:(\[[ xX]\])(?:[ \t]+|$))?(.*)$/;
const MATH_LINE_RE = /^[ \t]*\$\$(.+?)\$\$[ \t]*$/;
const MATH_FENCE_RE = /^[ \t]*\$\$[ \t]*$/;
const TAG_OPEN_RE = /^[ \t]*<([a-zA-Z][\w-]*)\b([^<>]*?)(\/?)>/;
// `{color="blue"}`, `{toggle="true" color="red"}`: a block's attribute list.
const ATTRS_RE = /[ \t]*\{[ \t]*[\w-]+="[^"}]*"(?:[ \t]+[\w-]+="[^"}]*")*[ \t]*\}[ \t]*$/;

const CONTAINER_TAGS = new Set([
  "callout",
  "details",
  "toggle",
  "columns",
  "column",
  "synced-block",
  "synced-block-reference",
  "quote",
]);
const CHILD_TAGS: Record<string, "page" | "database"> = {
  page: "page",
  "child-page": "page",
  database: "database",
  "child-database": "database",
  "data-source": "database",
};
const FILE_TAGS = new Set(["file", "audio", "video", "pdf", "image", "embed", "bookmark"]);
const SILENT_TAGS = new Set(["table-of-contents", "breadcrumb", "empty-block"]);

/** Tag names compared with `_` as `-`, so `synced_block` and `column_list`
 *  read the same as their dashed spellings. */
function tagName(raw: string): string {
  const name = raw.toLowerCase().replace(/_/g, "-");
  return name === "column-list" ? "columns" : name;
}

function isBlockTag(name: string): boolean {
  return (
    CONTAINER_TAGS.has(name) ||
    name in CHILD_TAGS ||
    FILE_TAGS.has(name) ||
    SILENT_TAGS.has(name) ||
    name === "table" ||
    name === "unknown" ||
    name === "equation"
  );
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const stripAttrs = (line: string): string => line.replace(ATTRS_RE, "");

/** Indentation in columns, a tab reaching the next multiple of four. */
function columns(whitespace: string): number {
  let col = 0;
  for (const ch of whitespace) col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
  return col;
}

const indentOf = (line: string): number => columns(/^[ \t]*/.exec(line)?.[0] ?? "");

/** The line with `n` columns of leading whitespace removed. */
function stripColumns(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
    col = line[i] === "\t" ? col + 4 - (col % 4) : col + 1;
    i++;
  }
  return " ".repeat(Math.max(0, col - n)) + line.slice(i);
}

/** How the text was written: by Notion, one block per line, or as on
 *  GitHub, where a paragraph wraps over lines and tables are pipes. */
type Dialect = "notion" | "github";

const lines = (markdown: string): string[] => markdown.replace(/\r\n?/g, "\n").split("\n");

export function parseNotionMarkdown(markdown: string): NotionBlock[] {
  return parseBlocks(lines(markdown), "notion");
}

/** A Markdown file as GitHub renders it. */
export function parseGitHubMarkdown(markdown: string): NotionBlock[] {
  return parseBlocks(lines(markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "")), "github");
}

/** The text of a run of inlines, marks dropped. */
export function inlineText(inlines: NotionInline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
        case "code":
          return inline.text;
        case "strong":
        case "em":
        case "strike":
        case "underline":
        case "link":
          return inlineText(inline.children);
        case "image":
          return inline.alt;
        case "mention":
          return inline.label;
        case "user":
          return `@${inline.name}`;
        case "date":
          return inline.end ? `${inline.start} to ${inline.end}` : inline.start;
        case "break":
          return "\n";
      }
    })
    .join("");
}

function parseBlocks(input: string[], dialect: Dialect): NotionBlock[] {
  const lines = [...input];
  const blocks: NotionBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const [, marks, language] = fence;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !isFenceClose(lines[j], marks)) {
        body.push(lines[j]);
        j++;
      }
      blocks.push({ type: "code", language, text: body.join("\n") });
      i = j + 1;
      continue;
    }
    const math = MATH_LINE_RE.exec(line);
    if (math) {
      blocks.push({ type: "equation", text: math[1].trim() });
      i++;
      continue;
    }
    if (MATH_FENCE_RE.test(line)) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !MATH_FENCE_RE.test(lines[j])) {
        body.push(lines[j]);
        j++;
      }
      blocks.push({ type: "equation", text: body.join("\n").trim() });
      i = j + 1;
      continue;
    }
    const tag = TAG_OPEN_RE.exec(line);
    if (tag && isBlockTag(tagName(tag[1]))) {
      i = parseTagBlock(lines, i, tag, blocks, dialect);
      continue;
    }
    if (dialect === "github" && isPipeTableStart(lines, i)) {
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== "" && lines[j].includes("|")) j++;
      blocks.push(parsePipeTable(lines.slice(i, j)));
      i = j;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, children: parseInline(stripAttrs(heading[2])) });
      i++;
      continue;
    }
    if (RULE_RE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      let j = i;
      while (j < lines.length && QUOTE_RE.test(lines[j])) {
        body.push(lines[j].replace(QUOTE_RE, ""));
        j++;
      }
      blocks.push({ type: "quote", children: parseBlocks(body, dialect) });
      i = j;
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item) {
      const end = listRegionEnd(lines, i, columns(item[1]), isOrdered(item[2]));
      blocks.push(parseList(lines.slice(i, end), dialect));
      i = end;
      continue;
    }
    // On GitHub a paragraph runs on until a blank line or another block.
    const text = [line.trim()];
    i++;
    while (dialect === "github" && i < lines.length && continuesParagraph(lines, i)) {
      text.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(stripAttrs(text.join(" "))) });
  }
  return blocks;
}

/** Whether line `i` carries on the GitHub paragraph above it, rather than
 *  ending it with a blank line or starting a block of its own. */
function continuesParagraph(lines: string[], i: number): boolean {
  const line = lines[i];
  if (line.trim() === "") return false;
  const tag = TAG_OPEN_RE.exec(line);
  return !(
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    RULE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line) ||
    MATH_FENCE_RE.test(line) ||
    (tag && isBlockTag(tagName(tag[1]))) ||
    isPipeTableStart(lines, i)
  );
}

const PIPE_DELIMITER_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** A GitHub table: a row of cells, then a row of dashes under them. */
function isPipeTableStart(lines: string[], i: number): boolean {
  const next = lines[i + 1];
  return (
    lines[i].includes("|") &&
    next !== undefined &&
    next.includes("|") &&
    PIPE_DELIMITER_RE.test(next)
  );
}

/** A row's cells: split on the pipes not escaped, outer pipes dropped. */
function pipeCells(row: string): NotionInline[][] {
  const trimmed = row
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => parseInline(cell.trim().replace(/\\\|/g, "|")));
}

/** A GitHub table's header, delimiter and body rows. */
function parsePipeTable(rows: string[]): NotionBlock {
  return { type: "table", header: pipeCells(rows[0]), rows: rows.slice(2).map(pipeCells) };
}

function isFenceClose(line: string, marks: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(marks) && /^[`~]+$/.test(trimmed);
}

const isOrdered = (marker: string): boolean => /^\d/.test(marker);

/** Where the list starting at `start` (its first item indented `base`
 *  columns) ends: at the first line that is neither an item of the same
 *  kind at that indent, nor an item or child indented deeper, nor a blank
 *  line followed by one of those. */
function listRegionEnd(lines: string[], start: number, base: number, ordered: boolean): number {
  let j = start + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === "") {
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      if (k < lines.length && belongsToList(lines[k], base, ordered)) {
        j = k;
        continue;
      }
      return j;
    }
    if (!belongsToList(line, base, ordered)) return j;
    j++;
  }
  return j;
}

function belongsToList(line: string, base: number, ordered: boolean): boolean {
  const item = LIST_RE.exec(line);
  if (item) {
    const indent = columns(item[1]);
    return indent > base || (indent === base && isOrdered(item[2]) === ordered);
  }
  return indentOf(line) > base;
}

function parseList(region: string[], dialect: Dialect): NotionBlock {
  const first = LIST_RE.exec(region[0]);
  const base = first ? columns(first[1]) : 0;
  const ordered = isOrdered(first?.[2] ?? "");
  const items: { checked: boolean | null; offset: number; lines: string[] }[] = [];
  for (const line of region) {
    const item = LIST_RE.exec(line);
    if (item && columns(item[1]) <= base) {
      items.push({
        checked: item[4] ? /x/i.test(item[4]) : null,
        // Children sit at the item's content column.
        offset: base + item[2].length + item[3].length,
        lines: [stripAttrs(item[5])],
      });
      continue;
    }
    const current = items.at(-1);
    if (current) current.lines.push(stripColumns(line, current.offset));
  }
  return {
    type: "list",
    ordered,
    items: items.map((item) => ({
      checked: item.checked,
      children: parseBlocks(item.lines, dialect),
    })),
  };
}

/** The lines inside an element opened on line `i` (after the open tag) up to
 *  its matching close tag, nesting of the same tag honored; an unterminated
 *  element runs to the end. `trailing` is what followed the close tag. */
function elementContent(
  lines: string[],
  i: number,
  name: string,
  afterOpen: string,
): { content: string[]; next: number; trailing: string } {
  const pattern = new RegExp(`<(/?)${name.replace(/-/g, "[-_]")}\\b[^<>]*?>`, "gi");
  let depth = 1;
  const content: string[] = [];
  let text = afterOpen;
  let j = i;
  for (;;) {
    for (const match of text.matchAll(pattern)) {
      const closing = match[1] === "/";
      if (!closing && match[0].endsWith("/>")) continue;
      depth += closing ? -1 : 1;
      if (depth === 0) {
        const at = match.index ?? 0;
        content.push(text.slice(0, at));
        return { content, next: j + 1, trailing: text.slice(at + match[0].length) };
      }
    }
    content.push(text);
    j++;
    if (j >= lines.length) return { content, next: j, trailing: "" };
    text = lines[j];
  }
}

function parseTagBlock(
  lines: string[],
  i: number,
  tag: RegExpExecArray,
  blocks: NotionBlock[],
  dialect: Dialect,
): number {
  const name = tagName(tag[1]);
  const attrs = tag[2];
  const afterOpen = lines[i].slice(tag[0].length);
  if (tag[3] === "/" || SILENT_TAGS.has(name)) {
    if (name === "unknown") {
      blocks.push({ type: "unknown", href: attr(attrs, "url"), alt: attr(attrs, "alt") ?? "" });
    } else if (FILE_TAGS.has(name) || name in CHILD_TAGS) {
      const src = attr(attrs, "src") ?? attr(attrs, "url");
      blocks.push({ type: "file", kind: name, src, label: attr(attrs, "alt") ?? name });
    }
    if (afterOpen.trim()) lines.splice(i + 1, 0, afterOpen);
    return i + 1;
  }
  const { content, next, trailing } = elementContent(lines, i, name, afterOpen);
  if (trailing.trim()) lines.splice(next, 0, trailing);
  const text = content.join("\n");
  const child = CHILD_TAGS[name];
  if (child) {
    const title = inlineText(parseInline(text.trim())) || attr(attrs, "title") || "";
    blocks.push({ type: "child", kind: child, href: attr(attrs, "url") ?? "", title });
  } else if (FILE_TAGS.has(name)) {
    const src = attr(attrs, "src") ?? attr(attrs, "url");
    const label = inlineText(parseInline(text.trim())) || attr(attrs, "alt") || name;
    blocks.push({ type: "file", kind: name, src, label });
  } else if (name === "unknown") {
    const alt = attr(attrs, "alt") ?? inlineText(parseInline(text.trim()));
    blocks.push({ type: "unknown", href: attr(attrs, "url"), alt });
  } else if (name === "equation") {
    blocks.push({ type: "equation", text: text.trim() });
  } else if (name === "table") {
    blocks.push(parseTable(text, attr(attrs, "header-row") === "true"));
  } else if (name === "callout") {
    blocks.push({
      type: "callout",
      icon: attr(attrs, "icon"),
      children: parseBlocks(content, dialect),
    });
  } else if (name === "details" || name === "toggle") {
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(text);
    const rest = summary ? text.replace(summary[0], "") : text;
    blocks.push({
      type: "details",
      summary: parseInline((summary?.[1] ?? "").trim()),
      children: parseBlocks(rest.split("\n"), dialect),
    });
  } else if (name === "columns") {
    blocks.push({ type: "columns", columns: splitColumns(content, dialect) });
  } else {
    // column outside a column list, synced blocks, quote: contents in place.
    blocks.push(...parseBlocks(content, dialect));
  }
  return next;
}

/** `<tr>` rows of `<td>` cells (a `<th>` counts as a cell); the first row is
 *  the header when the table says so. */
function parseTable(text: string, headerRow: boolean): NotionBlock {
  const rows = [...text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((cell) =>
      parseInline(cell[1].trim()),
    ),
  );
  return {
    type: "table",
    header: headerRow ? (rows[0] ?? []) : [],
    rows: headerRow ? rows.slice(1) : rows,
  };
}

function splitColumns(content: string[], dialect: Dialect): NotionBlock[][] {
  const lines = [...content];
  const columns: NotionBlock[][] = [];
  let loose: string[] = [];
  const flush = () => {
    if (loose.some((l) => l.trim() !== "")) columns.push(parseBlocks(loose, dialect));
    loose = [];
  };
  let i = 0;
  while (i < lines.length) {
    const tag = TAG_OPEN_RE.exec(lines[i]);
    if (tag && tagName(tag[1]) === "column" && tag[3] !== "/") {
      flush();
      const {
        content: inner,
        next,
        trailing,
      } = elementContent(lines, i, "column", lines[i].slice(tag[0].length));
      if (trailing.trim()) lines.splice(next, 0, trailing);
      columns.push(parseBlocks(inner, dialect));
      i = next;
      continue;
    }
    loose.push(lines[i]);
    i++;
  }
  flush();
  return columns;
}

// ── Inline ────────────────────────────────────────────────────────────────

const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const LINK_RE = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
// `[^https://…]`: a citation.
const CITATION_RE = /^\[\^([^\]\s]+)\]/;
const INLINE_TAG_RE = /^<([a-zA-Z][\w-]*)\b([^<>]*?)(\/?)>/;
const ESCAPABLE_RE = /[\\`*_{}[\]()#+\-.!|<>~$^]/;
const DELIMITERS: [string, "strong" | "em" | "strike"][] = [
  ["**", "strong"],
  ["__", "strong"],
  ["~~", "strike"],
  ["*", "em"],
  ["_", "em"],
];

export function parseInline(text: string): NotionInline[] {
  const out: NotionInline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: decodeEntities(buffer) });
    buffer = "";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && ESCAPABLE_RE.test(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ type: "break" });
      i++;
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
      const close = text.indexOf(run, i + run.length);
      if (close !== -1) {
        flush();
        out.push({ type: "code", text: text.slice(i + run.length, close).trim() });
        i = close + run.length;
        continue;
      }
    }
    if (ch === "$" && text[i + 1] !== "$" && !/\s/.test(text[i + 1] ?? " ")) {
      const close = text.indexOf("$", i + 1);
      if (close !== -1 && !/\s/.test(text[close - 1])) {
        flush();
        out.push({ type: "code", text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (ch === "!" && text[i + 1] === "[") {
      const m = IMAGE_RE.exec(text.slice(i));
      if (m) {
        flush();
        out.push({ type: "image", src: decodeEntities(m[2]), alt: decodeEntities(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const link = LINK_RE.exec(text.slice(i));
      if (link) {
        flush();
        out.push({ type: "link", href: decodeEntities(link[2]), children: parseInline(link[1]) });
        i += link[0].length;
        continue;
      }
      const citation = CITATION_RE.exec(text.slice(i));
      if (citation) {
        flush();
        out.push({
          type: "link",
          href: citation[1],
          children: [{ type: "text", text: "[source]" }],
        });
        i += citation[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const m = INLINE_TAG_RE.exec(text.slice(i));
      if (m) {
        flush();
        i += m[0].length + parseInlineTag(text.slice(i + m[0].length), m, out);
        continue;
      }
    }
    let matched = false;
    for (const [mark, type] of DELIMITERS) {
      if (!text.startsWith(mark, i)) continue;
      const close = findDelimiterClose(text, i, mark);
      if (close === -1) continue;
      flush();
      out.push({ type, children: parseInline(text.slice(i + mark.length, close)) });
      i = close + mark.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buffer += ch;
    i++;
  }
  flush();
  return out;
}

/** The index of the closing delimiter, or -1: the run must open before a
 *  non-space and close after one, an escaped mark never closes, and `_`
 *  never opens or closes inside a word. */
function findDelimiterClose(text: string, at: number, mark: string): number {
  const start = at + mark.length;
  if (start >= text.length || /\s/.test(text[start])) return -1;
  if (mark === "_" && at > 0 && /\w/.test(text[at - 1])) return -1;
  let from = start;
  for (;;) {
    const close = text.indexOf(mark, from);
    if (close === -1) return -1;
    const escaped = text[close - 1] === "\\";
    const closesWord = mark === "_" && /\w/.test(text[close + 1] ?? " ");
    if (close > start && !escaped && !/\s/.test(text[close - 1]) && !closesWord) return close;
    from = close + 1;
  }
}

/** Handles an inline tag whose open tag was just consumed; `rest` is the
 *  text after it. Pushes what it renders as and returns how much of `rest`
 *  it consumed. */
function parseInlineTag(rest: string, open: RegExpExecArray, out: NotionInline[]): number {
  const name = tagName(open[1]);
  const attrs = open[2];
  if (open[3] === "/" || name === "br") {
    if (name === "mention-date" || name === "date") {
      const time = attr(attrs, "startTime");
      const start = `${attr(attrs, "start") ?? ""}${time ? ` ${time}` : ""}`;
      out.push({ type: "date", start, end: attr(attrs, "end") });
    } else if (name === "br") {
      out.push({ type: "break" });
    } else if (name === "mention-user") {
      out.push({ type: "user", name: attr(attrs, "name") ?? "someone" });
    } else if (name.startsWith("mention-") || name in CHILD_TAGS) {
      const href = attr(attrs, "url") ?? "";
      out.push({ type: "mention", href, label: attr(attrs, "title") ?? href });
    } else if (name === "unknown") {
      const alt = attr(attrs, "alt") ?? "";
      if (alt) out.push({ type: "text", text: alt });
    }
    return 0;
  }
  const close = new RegExp(`</${open[1].replace(/[-_]/g, "[-_]")}\\s*>`, "i").exec(rest);
  const inner = close ? rest.slice(0, close.index) : "";
  const consumed = close ? close.index + close[0].length : 0;
  const label = inlineText(parseInline(inner)).trim();
  if (name === "mention-user" || name === "user") {
    out.push({ type: "user", name: label || attr(attrs, "name") || "someone" });
  } else if (name.startsWith("mention-") || name in CHILD_TAGS) {
    const href = attr(attrs, "url") ?? attr(attrs, "href") ?? "";
    out.push({ type: "mention", href, label: label || href });
  } else if (name === "u" || name === "underline" || attr(attrs, "underline") === "true") {
    out.push({ type: "underline", children: parseInline(inner) });
  } else if (name === "s" || name === "del" || name === "strike") {
    out.push({ type: "strike", children: parseInline(inner) });
  } else if (name === "b" || name === "strong") {
    out.push({ type: "strong", children: parseInline(inner) });
  } else if (name === "i" || name === "em") {
    out.push({ type: "em", children: parseInline(inner) });
  } else if (name === "code") {
    out.push({ type: "code", text: inner });
  } else if (name === "a") {
    out.push({ type: "link", href: attr(attrs, "href") ?? "", children: parseInline(inner) });
  } else {
    out.push(...parseInline(inner));
  }
  return consumed;
}
