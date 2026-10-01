// Reading the Notion mirror: the pages reader (its page tree, Go to page, its
// home, the open page, search across the copy) and Notion results in the
// Doco's search. Search is hybrid: full-text over titles and text fused with
// the nearest embedded chunks when the caller brings a query embedding, the
// matching chunk serving as the snippet. Everything here is scoped to one
// Doco; callers have already checked that the viewer can read it.
import { type SemanticQuery, rankEmbeddings } from "@doco/db";
import { chunkSnippet } from "./notion-chunks";
import { notionLinkedIds } from "./notion-markdown";
import { fuseRankings } from "./rank-fusion";
import { type ReaderListing, type ReaderTreeItem, listingsAlong } from "./reader";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface NotionPageRef {
  pageId: string;
  title: string;
  icon: string | null;
  /** The page's content is in the copy. False while it is still queued for
   *  its fetch: the copy knows it (its title, its place in the tree) but
   *  cannot show it yet. */
  copied: boolean;
}

/** A page as the reader's home lists it. */
export interface NotionPageSummary extends NotionPageRef {
  object: "page" | "data_source";
  /** Ancestor titles: "Handbook / Onboarding"; empty at the top. */
  where: string;
  lastEditedAt: string | null;
  lastEditedBy: string | null;
  /** Pages directly inside it. */
  children: number;
}

export interface NotionReaderPage extends NotionPageRef {
  object: "page" | "data_source";
  url: string;
  /** Ancestors, the root first. */
  path: NotionPageRef[];
  lastEditedAt: string | null;
  lastEditedBy: string | null;
  markdown: string;
  truncated: boolean;
  /** The mirrored pages this page's text names: its children, mentions and
   *  links, read from the text itself so they resolve however the links
   *  were recorded. */
  links: NotionPageRef[];
  /** Mirrored pages that link here. */
  backlinks: NotionPageRef[];
}

export interface NotionSearchHit {
  type: "notion_page";
  page_id: string;
  title: string;
  /** Ancestor titles: "Handbook / Onboarding". */
  path: string;
  url: string;
  last_edited_time: string | null;
  snippet: string;
  /** False for a page the copy lists but has not fetched yet. */
  copied: boolean;
}

/** What the pages reader shows at an address. `trail` is the open page's
 *  place in the tree (its ancestors, then itself), empty on the home and
 *  while searching. */
export type PagesView =
  | { view: "home"; recent: NotionPageSummary[]; top: NotionPageSummary[]; trail: string[] }
  | { view: "page"; page: NotionReaderPage; trail: string[] }
  | { view: "search"; query: string; hits: NotionSearchHit[]; trail: string[] };

const ROOT_LIMIT = 500;
const CHILD_LIMIT = 200;
const SNIPPET_WIDTH = 200;

/** The part of a page's text around the first search term, on word
 *  boundaries; the opening otherwise. Pure. */
export function notionSnippet(text: string, query: string, width = SNIPPET_WIDTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^["-]+|"+$/g, ""))
    .filter((term) => term.length > 1);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  let start = at === -1 ? 0 : Math.max(0, at - Math.floor(width / 3));
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space !== -1 && space < at) start = space + 1;
  }
  let end = Math.min(flat.length, start + width);
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > start) end = space;
  }
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, end).trim()}${tail}`;
}

interface TreeRow {
  page_id: string;
  title: string;
  icon: string | null;
  object: "page" | "data_source";
  copied: boolean;
  has_children: boolean;
  total: number | string;
}

const HAS_CHILDREN = `EXISTS (SELECT 1 FROM notion_pages ch
  WHERE ch.doco_id = p.doco_id AND ch.parent_id = p.page_id) AS has_children`;

function treeItem(row: Omit<TreeRow, "total">, where = ""): ReaderTreeItem {
  return {
    id: row.page_id,
    name: row.title,
    kind: row.object === "data_source" ? "database" : "page",
    icon: row.icon,
    hasChildren: row.has_children,
    files: null,
    pending: !row.copied,
    where,
  };
}

/** What is directly under one item of the page tree: at the top (""),
 *  every page whose parent isn't in the copy, by title; under a page, its
 *  children by title, and under a database, its rows newest first. */
export async function listPageTree(
  c: QueryClient,
  docoId: string,
  under: string,
): Promise<ReaderListing> {
  const rows = under
    ? (
        await c.query<TreeRow>(
          `SELECT p.page_id, p.title, p.icon, p.object, p.synced_at IS NOT NULL AS copied,
                  ${HAS_CHILDREN}, count(*) OVER () AS total
             FROM notion_pages p
             JOIN notion_pages parent
               ON parent.doco_id = p.doco_id AND parent.page_id = p.parent_id
            WHERE p.doco_id = $1 AND p.parent_id = $2
            ORDER BY CASE WHEN parent.object = 'data_source'
                          THEN p.last_edited_time END DESC NULLS LAST,
                     p.title, p.page_id
            LIMIT ${CHILD_LIMIT}`,
          [docoId, under],
        )
      ).rows
    : (
        await c.query<TreeRow>(
          `SELECT p.page_id, p.title, p.icon, p.object, p.synced_at IS NOT NULL AS copied,
                  ${HAS_CHILDREN}, count(*) OVER () AS total
             FROM notion_pages p
             LEFT JOIN notion_pages parent
               ON parent.doco_id = p.doco_id AND parent.page_id = p.parent_id
            WHERE p.doco_id = $1 AND parent.page_id IS NULL
            ORDER BY p.title, p.page_id
            LIMIT ${ROOT_LIMIT}`,
          [docoId],
        )
      ).rows;
  return {
    items: rows.map((row) => treeItem(row)),
    more: rows.length > 0 ? Math.max(0, Number(rows[0].total) - rows.length) : 0,
  };
}

/** The page tree's first listings with `pageId` open: the top-level pages,
 *  then each page down to it. */
export async function pageTreeAt(
  c: QueryClient,
  docoId: string,
  pageId: string,
): Promise<Record<string, ReaderListing>> {
  const ancestors = pageId ? ((await ancestorPaths(c, docoId, [pageId])).get(pageId) ?? []) : [];
  const trail = pageId ? [...ancestors.map((ref) => ref.pageId), pageId] : [];
  return listingsAlong(trail, (under) => listPageTree(c, docoId, under));
}

/** Pages whose title holds `query`, for Go to page: those whose title
 *  starts with it first, then by title. */
export async function findPages(
  c: QueryClient,
  docoId: string,
  query: string,
  limit: number,
): Promise<ReaderTreeItem[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rows = (
    await c.query<Omit<TreeRow, "total">>(
      `SELECT p.page_id, p.title, p.icon, p.object, p.synced_at IS NOT NULL AS copied,
              ${HAS_CHILDREN}
         FROM notion_pages p
        WHERE p.doco_id = $1 AND strpos(lower(p.title), $2) > 0
        ORDER BY CASE WHEN left(lower(p.title), length($2)) = $2 THEN 0 ELSE 1 END,
                 p.title, p.page_id
        LIMIT $3`,
      [docoId, q, limit],
    )
  ).rows;
  const paths = await ancestorPaths(
    c,
    docoId,
    rows.map((row) => row.page_id),
  );
  return rows.map((row) => treeItem(row, titlePath(paths.get(row.page_id) ?? [])));
}

/** Ancestor titles joined as a path: "Handbook / Onboarding". */
function titlePath(refs: NotionPageRef[]): string {
  return refs.map((ref) => ref.title || "Untitled").join(" / ");
}

/** Each page's mirrored ancestors, the root first. */
async function ancestorPaths(
  c: QueryClient,
  docoId: string,
  pageIds: string[],
): Promise<Map<string, NotionPageRef[]>> {
  const paths = new Map<string, NotionPageRef[]>();
  if (pageIds.length === 0) return paths;
  const rows = (
    await c.query<{
      start_id: string;
      page_id: string;
      title: string;
      icon: string | null;
      copied: boolean;
    }>(
      `WITH RECURSIVE up AS (
         SELECT p.page_id AS start_id, p.parent_id AS ancestor_id, 1 AS depth
           FROM notion_pages p
          WHERE p.doco_id = $1 AND p.page_id = ANY($2::text[]) AND p.parent_id IS NOT NULL
         UNION ALL
         SELECT up.start_id, a.parent_id, up.depth + 1
           FROM up
           JOIN notion_pages a ON a.doco_id = $1 AND a.page_id = up.ancestor_id
          WHERE a.parent_id IS NOT NULL AND up.depth < 32
       )
       SELECT up.start_id, a.page_id, a.title, a.icon, a.synced_at IS NOT NULL AS copied
         FROM up
         JOIN notion_pages a ON a.doco_id = $1 AND a.page_id = up.ancestor_id
        ORDER BY up.start_id, up.depth DESC`,
      [docoId, pageIds],
    )
  ).rows;
  for (const row of rows) {
    const path = paths.get(row.start_id) ?? [];
    path.push({ pageId: row.page_id, title: row.title, icon: row.icon, copied: row.copied });
    paths.set(row.start_id, path);
  }
  return paths;
}

interface PageRow {
  page_id: string;
  object: "page" | "data_source";
  title: string;
  icon: string | null;
  url: string;
  markdown: string;
  truncated: boolean;
  copied: boolean;
  last_edited_time: Date | string | null;
  editor: string | null;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

async function loadPage(
  c: QueryClient,
  docoId: string,
  pageId: string,
): Promise<NotionReaderPage | null> {
  const row = (
    await c.query<PageRow>(
      `SELECT p.page_id, p.object, p.title, p.icon, p.url, p.markdown, p.truncated,
              p.synced_at IS NOT NULL AS copied, p.last_edited_time, u.name AS editor
         FROM notion_pages p
         LEFT JOIN notion_users u ON u.doco_id = p.doco_id AND u.user_id = p.last_edited_by
        WHERE p.doco_id = $1 AND p.page_id = $2`,
      [docoId, pageId],
    )
  ).rows[0];
  if (!row) return null;
  const paths = await ancestorPaths(c, docoId, [pageId]);
  const refs = async (sql: string) =>
    (
      await c.query<{ page_id: string; title: string; icon: string | null; copied: boolean }>(sql, [
        docoId,
        pageId,
      ])
    ).rows.map((r) => ({ pageId: r.page_id, title: r.title, icon: r.icon, copied: r.copied }));
  const linkedIds = notionLinkedIds(row.markdown).filter((id) => id !== pageId);
  const links =
    linkedIds.length === 0
      ? []
      : (
          await c.query<{ page_id: string; title: string; icon: string | null; copied: boolean }>(
            `SELECT page_id, title, icon, synced_at IS NOT NULL AS copied
               FROM notion_pages
              WHERE doco_id = $1 AND page_id = ANY($2::text[])
              ORDER BY title, page_id`,
            [docoId, linkedIds],
          )
        ).rows.map((r) => ({ pageId: r.page_id, title: r.title, icon: r.icon, copied: r.copied }));
  const backlinks = await refs(
    `SELECT f.page_id, f.title, f.icon, f.synced_at IS NOT NULL AS copied
       FROM notion_links l
       JOIN notion_pages f ON f.doco_id = l.doco_id AND f.page_id = l.from_page_id
      WHERE l.doco_id = $1 AND l.to_page_id = $2
      ORDER BY f.title, f.page_id
      LIMIT 100`,
  );
  return {
    pageId: row.page_id,
    object: row.object,
    title: row.title,
    icon: row.icon,
    copied: row.copied,
    url: row.url,
    path: paths.get(pageId) ?? [],
    lastEditedAt: iso(row.last_edited_time),
    lastEditedBy: row.editor,
    markdown: row.markdown,
    truncated: row.truncated,
    links,
    backlinks,
  };
}

interface HitRow {
  page_id: string;
  title: string;
  url: string;
  last_edited_time: Date | string | null;
  plain_text: string;
  copied: boolean;
}

const HIT_COLUMNS = `p.page_id, p.title, p.url, p.last_edited_time,
  left(p.plain_text, 20000) AS plain_text, p.synced_at IS NOT NULL AS copied`;

/**
 * Pages matching the query, best first: the full-text ranking over titles
 * and text, fused by reciprocal rank with the nearest embedded chunks when
 * the caller brings a query embedding. A page found by its chunk shows that
 * chunk as its snippet; one found by its words shows the text around them.
 */
async function matchingPages(
  c: QueryClient,
  docoId: string,
  query: string,
  limit: number,
  semantic: SemanticQuery | null,
): Promise<NotionSearchHit[]> {
  const byWords = (
    await c.query<HitRow>(
      `SELECT ${HIT_COLUMNS}
         FROM notion_pages p, websearch_to_tsquery('simple', $2) q
        WHERE p.doco_id = $1 AND p.search_tsv @@ q
        ORDER BY ts_rank_cd(p.search_tsv, q) DESC, p.last_edited_time DESC NULLS LAST, p.page_id
        LIMIT $3`,
      [docoId, query, limit],
    )
  ).rows;
  const byMeaning = semantic
    ? await rankEmbeddings(c, {
        docoIds: [docoId],
        source: "notion",
        modelId: semantic.modelId,
        queryEmbedding: semantic.queryEmbedding,
        limit,
      })
    : [];
  const order = fuseRankings([
    byMeaning.map((hit) => hit.entity_id),
    byWords.map((row) => row.page_id),
  ]).slice(0, limit);
  const rows = new Map(byWords.map((row) => [row.page_id, row]));
  const missing = order.filter((id) => !rows.has(id));
  if (missing.length > 0) {
    for (const row of (
      await c.query<HitRow>(
        `SELECT ${HIT_COLUMNS} FROM notion_pages p
          WHERE p.doco_id = $1 AND p.page_id = ANY($2::text[])`,
        [docoId, missing],
      )
    ).rows) {
      rows.set(row.page_id, row);
    }
  }
  const chunks = new Map(byMeaning.map((hit) => [hit.entity_id, hit.chunk_text]));
  const ids = order.filter((id) => rows.has(id));
  const paths = await ancestorPaths(c, docoId, ids);
  return ids.map((id) => {
    const row = rows.get(id) as HitRow;
    const chunk = chunks.get(id);
    return {
      type: "notion_page",
      page_id: row.page_id,
      title: row.title,
      path: titlePath(paths.get(row.page_id) ?? []),
      url: row.url,
      last_edited_time: iso(row.last_edited_time),
      snippet: chunk ? chunkSnippet(chunk) : notionSnippet(row.plain_text, query),
      copied: row.copied,
    };
  });
}

async function mirrorName(c: QueryClient, docoId: string): Promise<string | null> {
  const row = (
    await c.query<{ workspace_name: string }>(
      "SELECT workspace_name FROM notion_mirrors WHERE doco_id = $1",
      [docoId],
    )
  ).rows[0];
  return row ? row.workspace_name : null;
}

const RECENT_LIMIT = 8;
const TOP_LIMIT = 60;

interface SummaryRow {
  page_id: string;
  object: "page" | "data_source";
  title: string;
  icon: string | null;
  copied: boolean;
  last_edited_time: Date | string | null;
  editor: string | null;
  children: number | string;
}

const SUMMARY_COLUMNS = `p.page_id, p.object, p.title, p.icon, p.synced_at IS NOT NULL AS copied,
  p.last_edited_time, u.name AS editor,
  (SELECT count(*) FROM notion_pages ch
    WHERE ch.doco_id = p.doco_id AND ch.parent_id = p.page_id) AS children`;
const SUMMARY_FROM = `notion_pages p
  LEFT JOIN notion_users u ON u.doco_id = p.doco_id AND u.user_id = p.last_edited_by`;

/** The reader's home: the copied pages edited most recently, and the
 *  pages at the top of the tree. */
async function loadPagesHome(c: QueryClient, docoId: string): Promise<PagesView> {
  const recent = (
    await c.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM}
        WHERE p.doco_id = $1 AND p.synced_at IS NOT NULL
        ORDER BY p.last_edited_time DESC NULLS LAST, p.title, p.page_id
        LIMIT ${RECENT_LIMIT}`,
      [docoId],
    )
  ).rows;
  const top = (
    await c.query<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM}
         LEFT JOIN notion_pages parent
           ON parent.doco_id = p.doco_id AND parent.page_id = p.parent_id
        WHERE p.doco_id = $1 AND parent.page_id IS NULL
        ORDER BY p.title, p.page_id
        LIMIT ${TOP_LIMIT}`,
      [docoId],
    )
  ).rows;
  const paths = await ancestorPaths(
    c,
    docoId,
    recent.map((row) => row.page_id),
  );
  const summary = (row: SummaryRow): NotionPageSummary => ({
    pageId: row.page_id,
    object: row.object,
    title: row.title,
    icon: row.icon,
    copied: row.copied,
    where: titlePath(paths.get(row.page_id) ?? []),
    lastEditedAt: iso(row.last_edited_time),
    lastEditedBy: row.editor,
    children: Number(row.children),
  });
  return { view: "home", recent: recent.map(summary), top: top.map(summary), trail: [] };
}

/**
 * What the pages reader shows: search results while there is a query, the
 * page `pageId` names, or the reader's home without one. Null for a page
 * the copy doesn't have.
 */
export async function loadPagesView(
  c: QueryClient,
  docoId: string,
  opts: { pageId: string; query: string; semantic?: SemanticQuery | null },
): Promise<PagesView | null> {
  const query = opts.query.trim();
  if (query) {
    const hits = await searchNotionMirror(c, docoId, query, 50, opts.semantic ?? null);
    return { view: "search", query, hits, trail: [] };
  }
  if (!opts.pageId) return loadPagesHome(c, docoId);
  const page = await loadPage(c, docoId, opts.pageId);
  if (!page) return null;
  return { view: "page", page, trail: [...page.path.map((ref) => ref.pageId), page.pageId] };
}

/** Notion pages matching `query`, for the Doco's search results. Empty for a
 *  Doco that doesn't mirror Notion. */
export async function searchNotionMirror(
  c: QueryClient,
  docoId: string,
  query: string,
  limit: number,
  semantic: SemanticQuery | null = null,
): Promise<NotionSearchHit[]> {
  if (!query.trim()) return [];
  if ((await mirrorName(c, docoId)) === null) return [];
  return matchingPages(c, docoId, query.trim(), limit, semantic);
}
