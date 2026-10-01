// Syntax highlighting for the code reader, done on the server so the browser
// gets the colors without the grammars. A file comes back as lines of tokens
// that the reader renders as spans, so a file's text is only ever text.
import { common, createLowlight } from "lowlight";

/** The colors the reader paints: comment, string, keyword, type, number,
 *  function or title, and tag. */
export type TokenClass = "c" | "s" | "k" | "t" | "n" | "f" | "g";

/** One line of a file: plain runs as strings, colored runs as [class, text]. */
export type CodeLine = Array<string | [TokenClass, string]>;

const lowlight = createLowlight(common);

// Past this, a file reads as plain lines: coloring it would cost more than
// it helps, and its tokens would weigh several times its text.
const HIGHLIGHT_MAX_CHARS = 100_000;

// highlight.js scopes (the first class, `hljs-` dropped) to the reader's colors.
const SCOPES: Record<string, TokenClass> = {
  comment: "c",
  quote: "c",
  doc: "c",
  keyword: "k",
  meta: "k",
  "selector-tag": "k",
  string: "s",
  regexp: "s",
  symbol: "s",
  char: "s",
  link: "s",
  number: "n",
  literal: "n",
  bullet: "n",
  title: "f",
  section: "f",
  "selector-id": "f",
  "selector-class": "f",
  type: "t",
  built_in: "t",
  attr: "t",
  attribute: "t",
  "template-variable": "t",
  tag: "g",
  name: "g",
};

/** The highlight.js language of a file, by its extension or, for a file
 *  like Makefile, its name; null when highlight.js doesn't know it. */
function languageOf(path: string): string | null {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  const dot = base.lastIndexOf(".");
  const name = dot > 0 ? base.slice(dot + 1) : base;
  return name && lowlight.registered(name) ? name : null;
}

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function scopeOf(node: HastNode): TokenClass | null {
  const classes = node.properties?.className;
  const first = Array.isArray(classes) ? String(classes[0] ?? "") : "";
  const scope = first.replace(/^hljs-/, "");
  return Object.hasOwn(SCOPES, scope) ? SCOPES[scope] : null;
}

/** The text runs of a highlighted tree, each with the color of the nearest
 *  scope around it that has one. */
function runs(node: HastNode, color: TokenClass | null, out: [TokenClass | null, string][]) {
  if (node.type === "text") {
    if (node.value) out.push([color, node.value]);
    return;
  }
  const own = node.type === "element" ? (scopeOf(node) ?? color) : color;
  for (const child of node.children ?? []) runs(child, own, out);
}

function plainLines(lines: string[]): CodeLine[] {
  return lines.map((line) => (line ? [line] : []));
}

/** A file's lines, colored by token when its language is known. Pure. */
export function highlightLines(path: string, content: string): CodeLine[] {
  if (content === "") return [];
  const text = content.endsWith("\n") ? content.slice(0, -1) : content;
  const language = languageOf(path);
  if (!language || text.length > HIGHLIGHT_MAX_CHARS) return plainLines(text.split("\n"));
  const out: [TokenClass | null, string][] = [];
  runs(lowlight.highlight(language, text) as HastNode, null, out);
  const lines: CodeLine[] = [[]];
  for (const [color, value] of out) {
    value.split("\n").forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      // Runs of one color, plain text included, join into one.
      if (color === null && typeof last === "string") line[line.length - 1] = last + part;
      else if (color !== null && Array.isArray(last) && last[0] === color) last[1] += part;
      else line.push(color === null ? part : [color, part]);
    });
  }
  return lines;
}
