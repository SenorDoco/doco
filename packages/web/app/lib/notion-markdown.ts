// The Notion mirror's page text, kept pure so the sync and the reader share
// it: stable page ids and URLs, Notion's "enhanced Markdown" normalized for
// storage, the plain text search sees, and the pages a page links to.
//
// Enhanced Markdown is what GET /v1/pages/{id}/markdown returns: CommonMark
// plus tags for what Markdown has no syntax for — <page url>, <database url>,
// <mention-page url>, <mention-user url>, <mention-date start end/>,
// <callout icon color>, <details><summary>, <columns><column>, <synced_block
// url>, <file src>, <audio>, <video>, <pdf>, and <unknown url alt/> for a
// block Notion could not render. Headings may carry `{color="…"}` or
// `{toggle="true"}` attributes.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;

/** A Notion id in its dashed form, from either the dashed or the bare
 *  32-hex form; null for anything else. */
export function normalizeNotionId(raw: string | null | undefined): string | null {
  const id = (raw ?? "").trim().toLowerCase();
  if (UUID_RE.test(id)) return id;
  if (!HEX32_RE.test(id)) return null;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** The page's stable link: Notion's own `url` embeds the title, which changes
 *  on rename; the bare id form resolves the same and never changes. */
export function notionPageUrl(id: string): string {
  return `https://www.notion.so/${id.replace(/-/g, "")}`;
}

/** The id a notion.so link points at (the last 32-hex run in its path, or
 *  the `p=` popup parameter); null for links elsewhere. */
export function notionIdFromUrl(url: string): string | null {
  let target: string;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)notion\.(so|site)$/.test(parsed.hostname)) return null;
    target = parsed.searchParams.get("p") ?? parsed.pathname;
  } catch {
    return null;
  }
  const runs = target.match(/[0-9a-f]{32}/gi);
  return runs ? normalizeNotionId(runs[runs.length - 1]) : null;
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s)"'<>]+/g;
const SIGNED_URL_RE = /[?&](X-Amz-Signature|X-Amz-Credential|expirationTimestamp|signature)=/;

/**
 * Enhanced Markdown as stored. Notion-hosted files come with a signed URL
 * that expires after an hour and differs on every fetch; stripping its query
 * string keeps an unchanged page hashing the same on every sync (the file's
 * path still identifies it). Everything else, tags included, is kept for the
 * reader. Pure.
 */
export function normalizeNotionMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(URL_IN_TEXT_RE, (url) => (SIGNED_URL_RE.test(url) ? url.replace(/\?.*$/, "") : url))
    .trim();
}

/**
 * What full-text search indexes: the text of the page with tags, headings
 * marks, list marks, emphasis marks and link targets removed. A mention's or
 * child page's title stays; a date mention becomes its dates. Pure.
 */
export function notionPlainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/<mention-date\b([^>]*)\/?>/gi, (_tag, attrs: string) => {
      const start = /\bstart="([^"]*)"/.exec(attrs)?.[1] ?? "";
      const end = /\bend="([^"]*)"/.exec(attrs)?.[1] ?? "";
      return end ? `${start} to ${end}` : start;
    })
    .replace(/<unknown\b[^>]*\/?>/gi, " ")
    .replace(/<\/?[a-z][a-z0-9_-]*\b[^>]*>/gi, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/[ \t]*\{[^{}\n]*=[^{}\n]*\}[ \t]*$/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*\d+\.[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/\$\$/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const TAG_URL_RE =
  /<(?:page|database|mention-page|mention-data-source|synced_block)\b[^>]*\burl="([^"]+)"/gi;
const LINK_RE = /\]\((https?:\/\/[^)\s]+)\)/gi;

/** The Notion objects a page's Markdown points at: child pages and databases,
 *  page and data source mentions, synced block sources, and plain notion.so
 *  links. Deduped, in order of appearance. Pure. */
export function notionLinkedIds(markdown: string): string[] {
  const ids = new Set<string>();
  for (const match of markdown.matchAll(TAG_URL_RE)) {
    const id = notionIdFromUrl(match[1]);
    if (id) ids.add(id);
  }
  for (const match of markdown.matchAll(LINK_RE)) {
    const id = notionIdFromUrl(match[1]);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Rich text as Notion returns it, joined to its plain text. Pure. */
export function notionRichTextToPlain(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const text = (part as { plain_text?: unknown } | null)?.plain_text;
      return typeof text === "string" ? text : "";
    })
    .join("")
    .trim();
}

/** A page or data source icon as one string: the emoji, or the image URL
 *  (Notion-hosted ones without their signed query). Null when there is none. */
export function notionIconToString(icon: unknown): string | null {
  if (!icon || typeof icon !== "object") return null;
  const record = icon as Record<string, unknown>;
  if (typeof record.emoji === "string") return record.emoji;
  for (const key of ["external", "file", "custom_emoji"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && typeof (nested as Json).url === "string") {
      return normalizeNotionMarkdown((nested as Json).url as string);
    }
  }
  return null;
}

type Json = Record<string, unknown>;

/**
 * A page's property values, flattened to plain values for storage and for the
 * rendered property block: select and status names, people names, dates,
 * numbers, checkboxes, the text of titles and rich text, relation page ids,
 * file names. Unsupported or empty values are left out. Pure.
 */
export function flattenNotionProperties(properties: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!properties || typeof properties !== "object") return out;
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const value = flattenNotionValue(raw as Json);
    if (value !== null && value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

function flattenNotionValue(property: Json): unknown {
  const type = typeof property.type === "string" ? property.type : "";
  const value = property[type];
  switch (type) {
    case "title":
    case "rich_text":
      return notionRichTextToPlain(value);
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return value ?? null;
    case "select":
    case "status":
      return typeof (value as Json | null)?.name === "string" ? (value as Json).name : null;
    case "multi_select":
      return Array.isArray(value)
        ? value.map((option) => String((option as Json).name ?? ""))
        : null;
    case "date": {
      const date = value as Json | null;
      if (!date || typeof date.start !== "string") return null;
      return typeof date.end === "string" ? `${date.start} to ${date.end}` : date.start;
    }
    case "people":
      return Array.isArray(value)
        ? value.map((user) => String((user as Json).name ?? (user as Json).id ?? ""))
        : null;
    case "files":
      return Array.isArray(value) ? value.map((file) => String((file as Json).name ?? "")) : null;
    case "relation":
      return Array.isArray(value) ? value.map((page) => String((page as Json).id ?? "")) : null;
    case "unique_id": {
      const id = value as Json | null;
      if (!id || typeof id.number !== "number") return null;
      return typeof id.prefix === "string" ? `${id.prefix}-${id.number}` : String(id.number);
    }
    case "formula":
    case "rollup": {
      const inner = value as Json | null;
      if (!inner || typeof inner.type !== "string") return null;
      const innerValue = inner[inner.type];
      if (inner.type === "date") return flattenNotionValue({ type: "date", date: innerValue });
      if (inner.type === "array" && Array.isArray(innerValue)) {
        return innerValue.map((item) => flattenNotionValue(item as Json)).filter((v) => v != null);
      }
      return typeof innerValue === "object" ? null : (innerValue ?? null);
    }
    case "created_by":
    case "last_edited_by":
      return typeof (value as Json | null)?.name === "string" ? (value as Json).name : null;
    case "verification":
      return typeof (value as Json | null)?.state === "string" ? (value as Json).state : null;
    default:
      return null;
  }
}

/**
 * The property block a database row's Markdown opens with, so a row's
 * properties read (and search) as part of its text:
 * `**Status:** Done · **Owner:** Tania`. Empty for a plain page. Pure.
 */
export function renderNotionProperties(properties: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    if (text) parts.push(`**${name}:** ${text}`);
  }
  return parts.join(" · ");
}
