// Reading the Notion mirror: the Doco home's Notion perspective (the page
// tree, the open page, search across the copy) and Notion results in the
// Doco's search. Search is hybrid: full-text over titles and text fused with
// the nearest embedded chunks when the caller brings a query embedding, the
// matching chunk serving as the snippet. Everything here is scoped to one
// Doco; callers have already checked that the viewer can read it.
import { type SemanticQuery, rankEmbeddings } from "@doco/db";
import { chunkSnippet } from "./notion-chunks";
import { notionLinkedIds } from "./notion-markdown";
import { fuseRankings } from "./rank-fusion";

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

export interface NotionTreeNode extends NotionPageRef {
  object: "page" | "data_source";
  hasChildren: boolean;
  /** Listed while the node is on the open page's path; null when collapsed. */
  children: NotionTreeNode[] | null;
  /** Children beyond the ones listed. */
  more: number;
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

export interface NotionPerspectiveData {
  /** Null for a Doco that doesn't mirror Notion. */
  workspaceName: string | null;
  pages: number;
  tree: NotionTreeNode[];
  /** Roots beyond the ones listed. */
  moreRoots: number;
  /** The page being read (null while searching or with no pages). */
  page: NotionReaderPage | null;
  /** The active search, "" when reading a page. */
  query: string;
  hits: NotionSearchHit[];
}

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
  parent_id: string | null;
  title: string;
  icon: string | null;
  object: "page" | "data_source";
  copied: boolean;
  has_children: boolean;
  total: number | string;
}

const HAS_CHILDREN = `EXISTS (SELECT 1 FROM notion_pages ch
  WHERE ch.doco_id = p.doco_id AND ch.parent_id = p.page_id) AS has_children`;

/** The page tree: every root (a page whose parent isn't mirrored), opened
 *  along `openIds` (the open page and its ancestors) to list their children. */
async function loadTree(
  c: QueryClient,
  docoId: string,
  openIds: string[],
): Promise<{ tree: NotionTreeNode[]; moreRoots: number }> {
  const roots = (
    await c.query<TreeRow>(
      `SELECT page_id, parent_id, title, icon, object, copied, has_children, total FROM (
         SELECT p.page_id, p.parent_id, p.title, p.icon, p.object,
                p.synced_at IS NOT NULL AS copied, ${HAS_CHILDREN},
                row_number() OVER (ORDER BY p.title, p.page_id) AS rn,
                count(*) OVER () AS total
           FROM notion_pages p
           LEFT JOIN notion_pages parent
             ON parent.doco_id = p.doco_id AND parent.page_id = p.parent_id
          WHERE p.doco_id = $1 AND parent.page_id IS NULL
       ) r
       WHERE rn <= $2 OR page_id = ANY($3::text[])
       ORDER BY rn`,
      [docoId, ROOT_LIMIT, openIds],
    )
  ).rows;
  const children =
    openIds.length === 0
      ? []
      : (
          await c.query<TreeRow>(
            `SELECT page_id, parent_id, title, icon, object, copied, has_children, total FROM (
               SELECT p.page_id, p.parent_id, p.title, p.icon, p.object,
                      p.synced_at IS NOT NULL AS copied, ${HAS_CHILDREN},
                      row_number() OVER (
                        PARTITION BY p.parent_id
                        ORDER BY CASE WHEN parent.object = 'data_source'
                                      THEN p.last_edited_time END DESC NULLS LAST,
                                 p.title, p.page_id) AS rn,
                      count(*) OVER (PARTITION BY p.parent_id) AS total
                 FROM notion_pages p
                 JOIN notion_pages parent
                   ON parent.doco_id = p.doco_id AND parent.page_id = p.parent_id
                WHERE p.doco_id = $1 AND p.parent_id = ANY($3::text[])
             ) r
             WHERE rn <= $2
             ORDER BY parent_id, rn`,
            [docoId, CHILD_LIMIT, openIds],
          )
        ).rows;
  const open = new Set(openIds);
  const byParent = new Map<string, TreeRow[]>();
  for (const row of children) {
    const siblings = byParent.get(row.parent_id ?? "") ?? [];
    siblings.push(row);
    byParent.set(row.parent_id ?? "", siblings);
  }
  const node = (row: TreeRow): NotionTreeNode => {
    const listed = open.has(row.page_id) ? (byParent.get(row.page_id) ?? []) : null;
    return {
      pageId: row.page_id,
      title: row.title,
      icon: row.icon,
      copied: row.copied,
      object: row.object,
      hasChildren: row.has_children,
      children: listed ? listed.map(node) : null,
      more: listed && listed.length > 0 ? Math.max(0, Number(listed[0].total) - listed.length) : 0,
    };
  };
  const moreRoots = roots.length > 0 ? Math.max(0, Number(roots[0].total) - roots.length) : 0;
  return { tree: roots.map(node), moreRoots };
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
      path: (paths.get(row.page_id) ?? []).map((ref) => ref.title || "Untitled").join(" / "),
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

export async function loadNotionPerspective(
  c: QueryClient,
  docoId: string,
  opts: {
    pageId?: string | null;
    query?: string | null;
    limit?: number;
    semantic?: SemanticQuery | null;
  },
): Promise<NotionPerspectiveData> {
  const query = opts.query?.trim() ?? "";
  const workspaceName = await mirrorName(c, docoId);
  if (workspaceName === null) {
    return { workspaceName, pages: 0, tree: [], moreRoots: 0, page: null, query, hits: [] };
  }
  const pages = Number(
    (
      await c.query<{ n: number | string }>(
        "SELECT count(*) AS n FROM notion_pages WHERE doco_id = $1",
        [docoId],
      )
    ).rows[0]?.n ?? 0,
  );
  if (query) {
    const hits = await matchingPages(c, docoId, query, opts.limit ?? 50, opts.semantic ?? null);
    const { tree, moreRoots } = await loadTree(c, docoId, []);
    return { workspaceName, pages, tree, moreRoots, page: null, query, hits };
  }
  // The requested page, else the most recently edited one.
  let page = opts.pageId ? await loadPage(c, docoId, opts.pageId) : null;
  if (!page) {
    const latest = (
      await c.query<{ page_id: string }>(
        `SELECT page_id FROM notion_pages WHERE doco_id = $1
          ORDER BY last_edited_time DESC NULLS LAST, title, page_id LIMIT 1`,
        [docoId],
      )
    ).rows[0];
    page = latest ? await loadPage(c, docoId, latest.page_id) : null;
  }
  const { tree, moreRoots } = await loadTree(
    c,
    docoId,
    page ? [...page.path.map((ref) => ref.pageId), page.pageId] : [],
  );
  return { workspaceName, pages, tree, moreRoots, page, query, hits: [] };
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
