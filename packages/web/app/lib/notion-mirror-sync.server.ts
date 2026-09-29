// The Notion mirror's paced background sync, run once a minute per mirror by
// /api/notion/mirror-sync (schema.sql → "Notion mirror"):
//
//   - discovery: walk Notion search (every page and data source shared with
//     the connection, most recently edited first) from the saved cursor,
//     inserting stubs with their listing metadata and flagging new or changed
//     pages for a fetch. A walk runs when none has completed, weekly, and
//     when an owner asked for a re-sync. When it finishes, rows Notion neither
//     listed nor mentioned since it started are flagged `verify`: the drain
//     re-fetches them, and deletes the ones Notion no longer serves;
//   - reconcile: between walks, every 15 minutes, the same search stopped as
//     soon as results are older than the last reconcile, to catch missed
//     webhooks and newly shared pages;
//   - drain: fetch the pages flagged for a fetch, webhook-flagged first — a
//     page's Markdown (and its object, when the flag came from an event), or
//     a data source's schema and rows — and write them in place;
//   - users: hourly, the workspace's members, for editor names.
//
// Four rules, learned from the Slack mirror's first big workspace (#1258):
// every phase has its own request budget so listing never starves the copy;
// a rate limit ends the phase (cursors are on the rows, `next_at` is stamped)
// and never the tick; one page failing is recorded on its row and skipped;
// lists are written in one statement. A lease (`ticking_until`) keeps the
// next cron tick off a mirror whose tick is still running, and `ticked_at`
// is the heartbeat the integration status reads.
import { createHash } from "node:crypto";
import { withClient } from "@doco/db";
import {
  type Json,
  NotionApiError,
  type NotionList,
  getNotionDataSource,
  getNotionDatabase,
  getNotionPage,
  getNotionPageMarkdown,
  listNotionUsers,
  queryNotionDataSource,
  refreshNotionToken,
  searchNotion,
} from "./notion-api.server";
import {
  flattenNotionProperties,
  normalizeNotionId,
  normalizeNotionMarkdown,
  notionChildRefs,
  notionIconToString,
  notionLinkedIds,
  notionPageUrl,
  notionPlainText,
  notionRichTextToPlain,
  renderNotionProperties,
} from "./notion-markdown";
import {
  getNotionTokens,
  markNotionMirrorNeedsReauth,
  storeNotionTokens,
} from "./notion-mirror-setup.server";
import {
  type NotionObjectKind,
  type NotionParentRef,
  asJson,
  deleteNotionPage,
  parentOf,
  str,
  upsertNotionUsers,
} from "./notion-mirror.server";

const MINUTE_MS = 60_000;
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS;
const RECONCILE_INTERVAL_MS = 15 * MINUTE_MS;
const RECONCILE_MARGIN_MS = 10 * MINUTE_MS;
const USERS_INTERVAL_MS = 60 * MINUTE_MS;
/** Requests a tick may spend listing before the copy gets the rest. */
const DISCOVERY_REQUESTS_PER_TICK = 20;
const RECONCILE_REQUESTS_PER_TICK = 10;
const USERS_REQUESTS_PER_TICK = 5;
/** Notion's standard budget is 180 a minute; two-thirds leaves the
 *  workspace's other integrations headroom. */
export const DEFAULT_REQUESTS_PER_MINUTE = 120;
/** A page failing this often is parked and listed on the mirror page. */
const MAX_FETCH_ATTEMPTS = 5;
/** Subtrees fetched for a page Notion's Markdown call truncated. */
const MAX_TRUNCATION_FOLLOW_UPS = 5;

export interface NotionMirrorTickResult {
  /** Why the tick did nothing, when it did nothing. */
  skipped?: "lease" | "reauth" | "paused";
  discovery: "walking" | "finished" | "reconciled" | "none";
  /** Rows a listing inserted or flagged this tick. */
  listed: number;
  /** Pages and data sources fetched this tick. */
  fetched: number;
  /** Fetches that failed this tick (the row keeps its retry count). */
  failed: number;
  requests: number;
  rateLimited: boolean;
}

export async function listActiveNotionMirrors(): Promise<{ docoId: string }[]> {
  const r = await withClient((c) =>
    c.query<{ doco_id: string }>(
      `SELECT m.doco_id
         FROM notion_mirrors m JOIN docos d ON d.id = m.doco_id
        WHERE d.deleted_at IS NULL
        ORDER BY m.created_at`,
    ),
  );
  return r.rows.map((row) => ({ docoId: row.doco_id }));
}

/** Thrown inside a phase when the tick's request budget or deadline is
 *  spent: the phase stops where it is (its cursor is on the rows). */
class BudgetSpent extends Error {}
/** Thrown when Notion no longer accepts the token and a refresh failed. */
class ReauthNeeded extends Error {}

interface MirrorRow {
  needs_reauth_at: Date | string | null;
  next_at: Date | string | null;
  discovery_cursor: string | null;
  discovery_started_at: Date | string | null;
  discovered_at: Date | string | null;
  reconciled_at: Date | string | null;
  /** Set while the last walk's listing was capped by Notion (see discoveryWalk). */
  listing_capped_at: Date | string | null;
  /** Set once the copied pages were scanned for children (see scanChildren). */
  children_scanned_at: Date | string | null;
  users_cursor: string | null;
  users_synced_at: Date | string | null;
}

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

/** One tick's Notion access: the budget, the deadline, and the token pair
 *  with a one-time refresh on 401. */
class Session {
  requests = 0;
  private accessToken: string;
  private refreshToken: string | null;
  private refreshed = false;

  constructor(
    readonly docoId: string,
    tokens: { accessToken: string; refreshToken: string | null },
    readonly fetchImpl: typeof fetch,
    private remaining: number,
    private readonly deadline: number,
  ) {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
  }

  get budgetLeft(): number {
    return Math.max(0, this.remaining);
  }

  /** Spend one request of the tick's budget (and of the phase's `phaseLeft`). */
  async call<T>(phase: { left: number }, fn: (token: string) => Promise<T>): Promise<T> {
    if (this.remaining <= 0 || phase.left <= 0 || Date.now() > this.deadline) {
      throw new BudgetSpent();
    }
    this.remaining--;
    phase.left--;
    this.requests++;
    try {
      return await fn(this.accessToken);
    } catch (error) {
      if (!(error instanceof NotionApiError) || error.status !== 401 || this.refreshed) throw error;
      await this.refresh();
      return fn(this.accessToken);
    }
  }

  private async refresh(): Promise<void> {
    this.refreshed = true;
    if (!this.refreshToken) throw new ReauthNeeded();
    let fresh: Awaited<ReturnType<typeof refreshNotionToken>>;
    try {
      fresh = await refreshNotionToken(this.refreshToken, this.fetchImpl);
    } catch {
      throw new ReauthNeeded();
    }
    this.accessToken = fresh.access_token;
    this.refreshToken = fresh.refresh_token ?? this.refreshToken;
    await storeNotionTokens(this.docoId, {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
    });
  }
}

export async function runNotionMirrorTick(args: {
  docoId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  requestsPerMinute?: number;
  /** Wall-clock budget for the tick; ticks are a minute apart. */
  deadlineMs?: number;
}): Promise<NotionMirrorTickResult> {
  const now = args.now ?? new Date();
  const result: NotionMirrorTickResult = {
    discovery: "none",
    listed: 0,
    fetched: 0,
    failed: 0,
    requests: 0,
    rateLimited: false,
  };
  const deadlineMs = args.deadlineMs ?? 50_000;
  const mirror = await claimMirror(args.docoId, now, deadlineMs + 5_000);
  if (!mirror) return { ...result, skipped: "lease" };
  try {
    if (mirror.needs_reauth_at) return { ...result, skipped: "reauth" };
    if (mirror.next_at && new Date(mirror.next_at).getTime() > now.getTime()) {
      return { ...result, skipped: "paused" };
    }
    const tokens = await getNotionTokens(args.docoId);
    if (!tokens) return { ...result, skipped: "reauth" };
    const session = new Session(
      args.docoId,
      tokens,
      args.fetchImpl ?? fetch,
      Math.max(1, args.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE),
      Date.now() + deadlineMs,
    );
    try {
      await listPhase(session, mirror, now, result);
      if (mirror.children_scanned_at === null) await scanChildren(session.docoId, now);
      await drainPhase(session, now, result);
      await usersPhase(session, mirror, now);
    } catch (error) {
      if (error instanceof BudgetSpent) {
        // Fine: the cursors are on the rows; the next tick carries on.
      } else if (error instanceof ReauthNeeded) {
        await markNotionMirrorNeedsReauth(args.docoId);
      } else if (error instanceof NotionApiError && error.code === "rate_limited") {
        result.rateLimited = true;
        await pause(args.docoId, new Date(now.getTime() + (error.retryAfterMs ?? MINUTE_MS)));
      } else {
        throw error;
      }
    }
    result.requests = session.requests;
    return result;
  } finally {
    await releaseMirror(args.docoId, now);
  }
}

async function claimMirror(docoId: string, now: Date, leaseMs: number): Promise<MirrorRow | null> {
  const r = await withClient((c) =>
    c.query<MirrorRow>(
      `UPDATE notion_mirrors SET ticking_until = $2
        WHERE doco_id = $1 AND (ticking_until IS NULL OR ticking_until < $3)
        RETURNING needs_reauth_at, next_at, discovery_cursor, discovery_started_at, discovered_at,
                  reconciled_at, listing_capped_at, children_scanned_at, users_cursor,
                  users_synced_at`,
      [docoId, new Date(now.getTime() + leaseMs), now],
    ),
  );
  return r.rows[0] ?? null;
}

async function releaseMirror(docoId: string, now: Date): Promise<void> {
  await withClient((c) =>
    c.query("UPDATE notion_mirrors SET ticking_until = NULL, ticked_at = $2 WHERE doco_id = $1", [
      docoId,
      now,
    ]),
  );
}

async function pause(docoId: string, until: Date): Promise<void> {
  await withClient((c) =>
    c.query("UPDATE notion_mirrors SET next_at = $2 WHERE doco_id = $1", [docoId, until]),
  );
}

async function setMirror(docoId: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  await withClient((c) =>
    c.query(
      `UPDATE notion_mirrors SET ${keys.map((key, i) => `${key} = $${i + 2}`).join(", ")}
        WHERE doco_id = $1`,
      [docoId, ...keys.map((key) => fields[key])],
    ),
  );
}

// ── Listing: discovery walks and reconciles ───────────────────────────────

const ms = (value: Date | string | null): number | null =>
  value === null ? null : new Date(value).getTime();

async function listPhase(
  session: Session,
  mirror: MirrorRow,
  now: Date,
  result: NotionMirrorTickResult,
): Promise<void> {
  const started = ms(mirror.discovery_started_at);
  const discovered = ms(mirror.discovered_at);
  const walking = started !== null && (discovered === null || started > discovered);
  const walkDue = discovered === null || now.getTime() - discovered > WEEK_MS;
  if (walking || walkDue) {
    await discoveryWalk(session, mirror, now, result, walking ? started : null);
    return;
  }
  const reconciled = ms(mirror.reconciled_at) ?? discovered;
  if (reconciled !== null && now.getTime() - reconciled >= RECONCILE_INTERVAL_MS) {
    await reconcile(session, now, result, reconciled - RECONCILE_MARGIN_MS);
  }
}

/** Continue (or start) the discovery walk from its cursor, up to the phase's
 *  request budget; on the last page finish it. */
async function discoveryWalk(
  session: Session,
  mirror: MirrorRow,
  now: Date,
  result: NotionMirrorTickResult,
  inProgressSince: number | null,
): Promise<void> {
  const startedAt = inProgressSince === null ? now : new Date(inProgressSince);
  let cursor = inProgressSince === null ? null : mirror.discovery_cursor;
  if (inProgressSince === null) {
    await setMirror(session.docoId, { discovery_started_at: now, discovery_cursor: null });
  }
  // Notion caps how many results one search walk may page through, and says
  // so on the page where it stops. A capped listing is not the whole
  // workspace: the pages it left out are found through the pages that name
  // them (queueChildren), and none of them may be taken for gone.
  let capped =
    inProgressSince !== null &&
    (ms(mirror.listing_capped_at) ?? Number.NEGATIVE_INFINITY) >= startedAt.getTime();
  result.discovery = "walking";
  const phase = { left: DISCOVERY_REQUESTS_PER_TICK };
  for (;;) {
    let page: NotionList;
    try {
      page = await session.call(phase, (token) => searchNotion(token, cursor, session.fetchImpl));
    } catch (error) {
      if (error instanceof BudgetSpent) return;
      throw error;
    }
    result.listed += await upsertListing(session.docoId, page.results, now, "discover");
    if (!capped && listingCapped(page)) {
      capped = true;
      await setMirror(session.docoId, { listing_capped_at: now });
    }
    if (page.has_more && page.next_cursor) {
      cursor = page.next_cursor;
      await setMirror(session.docoId, { discovery_cursor: cursor });
      continue;
    }
    // The walk is complete. Rows Notion neither listed nor mentioned since it
    // started get re-fetched: the drain deletes the ones Notion no longer
    // serves and refreshes the rest. Not after a capped walk: an unlisted
    // page is then just one the listing had no room for.
    if (!capped) {
      await withClient((c) =>
        c.query(
          `UPDATE notion_pages
              SET fetch_pending = true, fetch_reason = 'verify', fetch_attempts = 0, fetch_error = NULL
            WHERE doco_id = $1 AND NOT fetch_pending AND (seen_at IS NULL OR seen_at < $2)`,
          [session.docoId, startedAt],
        ),
      );
    }
    await setMirror(session.docoId, {
      discovered_at: now,
      discovery_cursor: null,
      reconciled_at: now,
      ...(capped ? {} : { listing_capped_at: null }),
    });
    result.discovery = "finished";
    return;
  }
}

function listingCapped(page: NotionList): boolean {
  const status = page.request_status;
  return status?.type === "incomplete" || status?.reason === "query_result_limit_reached";
}

/**
 * Queue the child pages and databases a page's Markdown names that the copy
 * lacks: a page reads whole only with its children, and the listing may have
 * missed them (a capped walk, or Notion's index lagging). The parent is
 * known, so they take their place in the tree at once, titled as the parent
 * shows them until their own fetch. A database is queued under its own id and
 * resolved into its data sources by the drain (resolveChildDatabase).
 */
async function queueChildren(
  c: QueryClient,
  docoId: string,
  parentId: string,
  markdown: string,
): Promise<number> {
  const refs = notionChildRefs(markdown).filter((ref) => ref.id !== parentId);
  if (refs.length === 0) return 0;
  const rows = await c.query<{ page_id: string }>(
    `INSERT INTO notion_pages
       (doco_id, page_id, object, parent_id, parent_type, title, url, fetch_pending, fetch_reason)
     SELECT $1, r.page_id, r.object, $2, 'page', r.title, r.url, true, r.reason
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
         AS r(page_id, object, title, url, reason)
     ON CONFLICT (doco_id, page_id) DO NOTHING
     RETURNING page_id`,
    [
      docoId,
      parentId,
      refs.map((ref) => ref.id),
      refs.map((ref) => (ref.kind === "page" ? "page" : "data_source")),
      refs.map((ref) => ref.title),
      refs.map((ref) => `https://www.notion.so/${ref.id.replace(/-/g, "")}`),
      refs.map((ref) => (ref.kind === "page" ? "child" : "child-database")),
    ],
  );
  return rows.rows.length;
}

/** Once per mirror: queue the children named by pages copied before the sync
 *  queued them at fetch time. Database work only; the drain fetches them. */
async function scanChildren(docoId: string, now: Date): Promise<void> {
  let after = "";
  for (;;) {
    const batch = await withClient((c) =>
      c.query<{ page_id: string; markdown: string }>(
        `SELECT page_id, markdown FROM notion_pages
          WHERE doco_id = $1 AND object = 'page' AND synced_at IS NOT NULL AND page_id > $2
          ORDER BY page_id LIMIT 200`,
        [docoId, after],
      ),
    );
    if (batch.rows.length === 0) break;
    await withClient(async (c) => {
      for (const row of batch.rows) await queueChildren(c, docoId, row.page_id, row.markdown);
    });
    after = batch.rows[batch.rows.length - 1].page_id;
  }
  await setMirror(docoId, { children_scanned_at: now });
}

/** Page the search, most recently edited first, until results predate
 *  `olderThanMs`; flag what changed. */
async function reconcile(
  session: Session,
  now: Date,
  result: NotionMirrorTickResult,
  olderThanMs: number,
): Promise<void> {
  const phase = { left: RECONCILE_REQUESTS_PER_TICK };
  let cursor: string | null = null;
  for (;;) {
    let page: NotionList;
    try {
      page = await session.call(phase, (token) => searchNotion(token, cursor, session.fetchImpl));
    } catch (error) {
      if (error instanceof BudgetSpent) return; // next tick tries again from the top
      throw error;
    }
    const recent = page.results.filter((object) => {
      const edited = Date.parse(str(asJson(object).last_edited_time));
      return !Number.isFinite(edited) || edited >= olderThanMs;
    });
    result.listed += await upsertListing(session.docoId, recent, now, "reconcile");
    const exhausted = recent.length < page.results.length || !page.has_more || !page.next_cursor;
    if (exhausted) break;
    cursor = page.next_cursor;
  }
  await setMirror(session.docoId, { reconciled_at: now });
  result.discovery = "reconciled";
}

interface ListedRow {
  pageId: string;
  object: NotionObjectKind;
  parent: NotionParentRef;
  title: string;
  icon: string | null;
  properties: Record<string, unknown>;
  createdTime: string | null;
  lastEditedTime: string | null;
  lastEditedBy: string | null;
  inTrash: boolean;
}

/** A page or data source object as the mirror stores it. Null for anything
 *  else Notion lists (a database container, an unknown object). */
export function listedRowFromObject(object: Json): ListedRow | null {
  const pageId = normalizeNotionId(str(object.id));
  if (!pageId) return null;
  const kind =
    object.object === "page" ? "page" : object.object === "data_source" ? "data_source" : null;
  if (!kind) return null;
  const parent =
    kind === "data_source" && object.database_parent
      ? parentOf({ parent: object.database_parent })
      : parentOf(object);
  return {
    pageId,
    object: kind,
    parent,
    title: kind === "page" ? pageTitle(object) : notionRichTextToPlain(object.title),
    icon: notionIconToString(object.icon),
    properties:
      kind === "page"
        ? flattenNotionProperties(object.properties)
        : dataSourceSchema(object.properties),
    createdTime: str(object.created_time) || null,
    lastEditedTime: str(object.last_edited_time) || null,
    lastEditedBy: str(asJson(object.last_edited_by).id) || null,
    inTrash: object.in_trash === true || object.archived === true,
  };
}

/** A page's title: whichever property is the title property (any name). */
function pageTitle(page: Json): string {
  const properties = asJson(page.properties);
  for (const value of Object.values(properties)) {
    const property = asJson(value);
    if (property.type === "title") return notionRichTextToPlain(property.title);
  }
  return "";
}

/** A data source's schema as plain strings: `{ Status: "status (Todo, Done)" }`. */
function dataSourceSchema(properties: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(asJson(properties))) {
    const property = asJson(raw);
    const type = str(property.type);
    if (!type) continue;
    const options = asJson(property[type]).options;
    const names = Array.isArray(options)
      ? options.map((option) => str(asJson(option).name)).filter(Boolean)
      : [];
    out[name] = names.length > 0 ? `${type} (${names.join(", ")})` : type;
  }
  return out;
}

/** Insert the listed objects as stubs, or refresh their metadata, in one
 *  statement, flagging the new and changed ones for a fetch and deleting the
 *  trashed ones. Returns how many were inserted or flagged. */
async function upsertListing(
  docoId: string,
  objects: Json[],
  now: Date,
  reason: "discover" | "reconcile",
): Promise<number> {
  const rows: ListedRow[] = [];
  for (const object of objects) {
    const row = listedRowFromObject(object);
    if (row) rows.push(row);
  }
  const trashed = rows.filter((row) => row.inTrash);
  for (const row of trashed) await deleteNotionPage(docoId, row.pageId);
  const live = rows.filter((row) => !row.inTrash);
  if (live.length === 0) return 0;
  const r = await withClient((c) =>
    c.query<{ flagged: boolean }>(
      `INSERT INTO notion_pages
         (doco_id, page_id, object, parent_id, parent_type, title, icon, url, properties,
          created_time, last_edited_time, last_edited_by, seen_at, fetch_pending, fetch_reason)
       SELECT $1, r.page_id, r.object, r.parent_id, r.parent_type, r.title, r.icon, r.url,
              r.properties::jsonb, r.created_time::timestamptz, r.last_edited_time::timestamptz,
              r.last_edited_by, $2, true, $3
         FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                     $10::text[], $11::text[], $12::text[], $13::text[], $14::text[])
           AS r(page_id, object, parent_id, parent_type, title, icon, url, properties,
                created_time, last_edited_time, last_edited_by)
       ON CONFLICT (doco_id, page_id) DO UPDATE SET
         object = EXCLUDED.object,
         parent_id = EXCLUDED.parent_id,
         parent_type = EXCLUDED.parent_type,
         title = EXCLUDED.title,
         icon = EXCLUDED.icon,
         properties = EXCLUDED.properties,
         created_time = EXCLUDED.created_time,
         last_edited_time = EXCLUDED.last_edited_time,
         last_edited_by = EXCLUDED.last_edited_by,
         seen_at = EXCLUDED.seen_at,
         fetch_pending = notion_pages.fetch_pending
           OR notion_pages.synced_at IS NULL
           OR notion_pages.last_edited_time IS DISTINCT FROM EXCLUDED.last_edited_time,
         fetch_reason = CASE WHEN notion_pages.fetch_pending THEN notion_pages.fetch_reason
                             ELSE EXCLUDED.fetch_reason END,
         fetch_attempts = CASE WHEN notion_pages.fetch_pending THEN notion_pages.fetch_attempts
                               ELSE 0 END,
         fetch_error = CASE WHEN notion_pages.fetch_pending THEN notion_pages.fetch_error
                            ELSE NULL END
       RETURNING fetch_pending AND fetch_reason = $3 AS flagged`,
      [
        docoId,
        now,
        reason,
        live.map((row) => row.pageId),
        live.map((row) => row.object),
        live.map((row) => row.parent.parentId),
        live.map((row) => row.parent.parentType),
        live.map((row) => row.title),
        live.map((row) => row.icon),
        live.map((row) => notionPageUrl(row.pageId)),
        live.map((row) => JSON.stringify(row.properties)),
        live.map((row) => row.createdTime),
        live.map((row) => row.lastEditedTime),
        live.map((row) => row.lastEditedBy),
      ],
    ),
  );
  return r.rows.filter((row) => row.flagged).length;
}

// ── Drain: fetching flagged pages and data sources ────────────────────────

interface PendingRow {
  page_id: string;
  object: NotionObjectKind;
  parent_type: string | null;
  fetch_reason: string | null;
  fetch_attempts: number;
  query_cursor: string | null;
  content_hash: string;
  properties: Record<string, unknown>;
}

async function drainPhase(
  session: Session,
  now: Date,
  result: NotionMirrorTickResult,
): Promise<void> {
  const phase = { left: Number.POSITIVE_INFINITY };
  for (;;) {
    if (session.budgetLeft <= 0) return;
    const rows = await withClient((c) =>
      c.query<PendingRow>(
        `SELECT page_id, object, parent_type, fetch_reason, fetch_attempts, query_cursor,
                content_hash, properties
           FROM notion_pages
          WHERE doco_id = $1 AND fetch_pending AND fetch_attempts < $2
          ORDER BY (fetch_reason = 'webhook') DESC, fetch_attempts, page_id
          LIMIT 20`,
        [session.docoId, MAX_FETCH_ATTEMPTS],
      ),
    );
    if (rows.rows.length === 0) return;
    for (const row of rows.rows) {
      try {
        if (row.fetch_reason === "child-database") {
          await resolveChildDatabase(session, phase, row, now);
        } else if (row.object === "data_source") {
          await fetchDataSource(session, phase, row, now);
        } else {
          await fetchPage(session, phase, row, now);
        }
        result.fetched++;
      } catch (error) {
        if (error instanceof BudgetSpent) return;
        if (error instanceof ReauthNeeded) throw error;
        if (error instanceof NotionApiError) {
          if (error.code === "rate_limited") throw error;
          if (error.status === 404) {
            // Unshared, or gone: the copy goes too.
            await deleteNotionPage(session.docoId, row.page_id);
            continue;
          }
        }
        result.failed++;
        await recordFetchFailure(session.docoId, row, error);
      }
    }
  }
}

/** Fetch one page: its object when the flag came from an event (a listing
 *  already wrote the metadata), then its Markdown, then write it in place. */
async function fetchPage(
  session: Session,
  phase: { left: number },
  row: PendingRow,
  now: Date,
): Promise<void> {
  const fromListing = row.fetch_reason === "discover" || row.fetch_reason === "reconcile";
  let listed: ListedRow | null = null;
  if (!fromListing) {
    const object = await session.call(phase, (token) =>
      getNotionPage(token, row.page_id, session.fetchImpl),
    );
    listed = listedRowFromObject(object);
    if (!listed || listed.inTrash) {
      await deleteNotionPage(session.docoId, row.page_id);
      return;
    }
  }
  const body = await session.call(phase, (token) =>
    getNotionPageMarkdown(token, row.page_id, session.fetchImpl),
  );
  let markdown = normalizeNotionMarkdown(str(body.markdown));
  let truncated = body.truncated === true;
  if (truncated) {
    const rest = (body.unknown_block_ids ?? []).slice(0, MAX_TRUNCATION_FOLLOW_UPS);
    for (const blockId of rest) {
      const subtree = await session.call(phase, (token) =>
        getNotionPageMarkdown(token, blockId, session.fetchImpl),
      );
      markdown = `${markdown}\n\n${normalizeNotionMarkdown(str(subtree.markdown))}`.trim();
    }
    truncated = (body.unknown_block_ids ?? []).length > rest.length;
  }
  const properties = listed ? listed.properties : row.properties;
  const isRow = (listed?.parent.parentType ?? row.parent_type) === "data_source";
  const propertyBlock = isRow ? renderNotionProperties(properties) : "";
  const stored = [propertyBlock, markdown].filter(Boolean).join("\n\n");
  const plain = notionPlainText(stored);
  const hash = contentHash(`${listed?.title ?? ""}\n${stored}`);
  await withClient(async (c) => {
    await c.query(
      `UPDATE notion_pages
          SET title = COALESCE($3, title),
              icon = CASE WHEN $4::boolean THEN $5 ELSE icon END,
              parent_id = COALESCE($6, parent_id),
              parent_type = COALESCE($7, parent_type),
              properties = $8::jsonb,
              markdown = $9, plain_text = $10, content_hash = $11,
              created_time = COALESCE($12::timestamptz, created_time),
              last_edited_time = COALESCE($13::timestamptz, last_edited_time),
              last_edited_by = COALESCE($14, last_edited_by),
              truncated = $15,
              fetch_pending = false, fetch_reason = NULL, fetch_attempts = 0, fetch_error = NULL,
              seen_at = $2, synced_at = $2
        WHERE doco_id = $1 AND page_id = $16`,
      [
        session.docoId,
        now,
        listed?.title ?? null,
        listed !== null,
        listed?.icon ?? null,
        listed?.parent.parentId ?? null,
        listed?.parent.parentType ?? null,
        JSON.stringify(properties),
        stored,
        plain,
        hash,
        listed?.createdTime ?? null,
        listed?.lastEditedTime ?? null,
        listed?.lastEditedBy ?? null,
        truncated,
        row.page_id,
      ],
    );
    if (hash !== row.content_hash) {
      const targets = notionLinkedIds(stored).filter((id) => id !== row.page_id);
      await c.query("DELETE FROM notion_links WHERE doco_id = $1 AND from_page_id = $2", [
        session.docoId,
        row.page_id,
      ]);
      if (targets.length > 0) {
        await c.query(
          `INSERT INTO notion_links (doco_id, from_page_id, to_page_id)
           SELECT $1, $2, t FROM unnest($3::text[]) AS t
           ON CONFLICT DO NOTHING`,
          [session.docoId, row.page_id, targets],
        );
      }
      await queueChildren(c, session.docoId, row.page_id, stored);
    }
  });
}

/** A `<database>` child names the database, not the data sources it holds:
 *  look them up, queue each under the page (as a listing would place them),
 *  and drop the database's own stub. */
async function resolveChildDatabase(
  session: Session,
  phase: { left: number },
  row: PendingRow,
  now: Date,
): Promise<void> {
  const database = await session.call(phase, (token) =>
    getNotionDatabase(token, row.page_id, session.fetchImpl),
  );
  const live = database.in_trash !== true && database.archived !== true;
  const sources = (Array.isArray(database.data_sources) ? database.data_sources : [])
    .map((source) => {
      const id = normalizeNotionId(str(asJson(source).id));
      return id ? { id, name: str(asJson(source).name) } : null;
    })
    .filter((source): source is { id: string; name: string } => source !== null);
  await withClient(async (c) => {
    if (live && sources.length > 0) {
      await c.query(
        `INSERT INTO notion_pages
           (doco_id, page_id, object, parent_id, parent_type, title, icon, url, seen_at,
            fetch_pending, fetch_reason)
         SELECT $1, r.page_id, 'data_source', p.parent_id, p.parent_type, r.title, $5, r.url, $6,
                true, 'child'
           FROM unnest($2::text[], $3::text[], $4::text[]) AS r(page_id, title, url),
                notion_pages p
          WHERE p.doco_id = $1 AND p.page_id = $7
         ON CONFLICT (doco_id, page_id) DO NOTHING`,
        [
          session.docoId,
          sources.map((source) => source.id),
          sources.map((source) => source.name),
          sources.map((source) => `https://www.notion.so/${source.id.replace(/-/g, "")}`),
          notionIconToString(database.icon),
          now,
          row.page_id,
        ],
      );
    }
    await c.query("DELETE FROM notion_pages WHERE doco_id = $1 AND page_id = $2", [
      session.docoId,
      row.page_id,
    ]);
  });
}

/** Fetch a data source: its schema (as the text of the row), then its rows,
 *  a page at a time from the saved cursor, as stubs for the drain. */
async function fetchDataSource(
  session: Session,
  phase: { left: number },
  row: PendingRow,
  now: Date,
): Promise<void> {
  if (!row.query_cursor) {
    const object = await session.call(phase, (token) =>
      getNotionDataSource(token, row.page_id, session.fetchImpl),
    );
    const listed = listedRowFromObject(object);
    if (!listed || listed.inTrash) {
      await deleteNotionPage(session.docoId, row.page_id);
      return;
    }
    const description = notionRichTextToPlain(object.description);
    const schema = Object.entries(listed.properties)
      .map(([name, type]) => `- **${name}**: ${String(type)}`)
      .join("\n");
    const markdown = [description, schema ? `Properties:\n${schema}` : ""]
      .filter(Boolean)
      .join("\n\n");
    await withClient((c) =>
      c.query(
        `UPDATE notion_pages
            SET title = $3, icon = $4, parent_id = COALESCE($5, parent_id),
                parent_type = COALESCE($6, parent_type), properties = $7::jsonb,
                markdown = $8, plain_text = $9, content_hash = $10,
                created_time = COALESCE($11::timestamptz, created_time),
                last_edited_time = COALESCE($12::timestamptz, last_edited_time),
                last_edited_by = COALESCE($13, last_edited_by),
                seen_at = $2, synced_at = $2
          WHERE doco_id = $1 AND page_id = $14`,
        [
          session.docoId,
          now,
          listed.title,
          listed.icon,
          listed.parent.parentId,
          listed.parent.parentType,
          JSON.stringify(listed.properties),
          markdown,
          notionPlainText(markdown),
          contentHash(`${listed.title}\n${markdown}`),
          listed.createdTime,
          listed.lastEditedTime,
          listed.lastEditedBy,
          row.page_id,
        ],
      ),
    );
  }
  let cursor = row.query_cursor;
  for (;;) {
    let page: NotionList;
    try {
      page = await session.call(phase, (token) =>
        queryNotionDataSource(token, row.page_id, cursor, session.fetchImpl),
      );
    } catch (error) {
      // Out of budget mid-listing: the cursor is saved, the next tick resumes.
      if (error instanceof BudgetSpent) {
        await withClient((c) =>
          c.query("UPDATE notion_pages SET query_cursor = $3 WHERE doco_id = $1 AND page_id = $2", [
            session.docoId,
            row.page_id,
            cursor,
          ]),
        );
      }
      throw error;
    }
    // Rows come as full page objects, parented on this data source.
    await upsertListing(session.docoId, page.results, now, "discover");
    if (page.has_more && page.next_cursor) {
      cursor = page.next_cursor;
      await withClient((c) =>
        c.query("UPDATE notion_pages SET query_cursor = $3 WHERE doco_id = $1 AND page_id = $2", [
          session.docoId,
          row.page_id,
          cursor,
        ]),
      );
      continue;
    }
    break;
  }
  await withClient((c) =>
    c.query(
      `UPDATE notion_pages
          SET query_cursor = NULL, fetch_pending = false, fetch_reason = NULL,
              fetch_attempts = 0, fetch_error = NULL, synced_at = $2
        WHERE doco_id = $1 AND page_id = $3`,
      [session.docoId, now, row.page_id],
    ),
  );
}

async function recordFetchFailure(docoId: string, row: PendingRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
  const attempts = row.fetch_attempts + 1;
  const parked = attempts >= MAX_FETCH_ATTEMPTS;
  if (parked)
    console.error(`[notion mirror] parking ${row.page_id} after ${attempts} attempts: ${message}`);
  await withClient((c) =>
    c.query(
      `UPDATE notion_pages
          SET fetch_attempts = $3, fetch_error = $4, fetch_pending = $5,
              fetch_reason = CASE WHEN $5 AND fetch_reason <> 'child-database' THEN 'retry'
                                  ELSE fetch_reason END
        WHERE doco_id = $1 AND page_id = $2`,
      [docoId, row.page_id, attempts, message, !parked],
    ),
  );
}

function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

// ── Users ─────────────────────────────────────────────────────────────────

async function usersPhase(session: Session, mirror: MirrorRow, now: Date): Promise<void> {
  const synced = ms(mirror.users_synced_at);
  const due =
    mirror.users_cursor !== null || synced === null || now.getTime() - synced >= USERS_INTERVAL_MS;
  if (!due) return;
  const phase = { left: USERS_REQUESTS_PER_TICK };
  let cursor = mirror.users_cursor;
  for (;;) {
    let page: NotionList;
    try {
      page = await session.call(phase, (token) =>
        listNotionUsers(token, cursor, session.fetchImpl),
      );
    } catch (error) {
      if (error instanceof BudgetSpent) {
        await setMirror(session.docoId, { users_cursor: cursor });
        return;
      }
      if (error instanceof NotionApiError && error.status === 403) {
        // No user-information capability: names stay ids. Try again next hour.
        await setMirror(session.docoId, { users_cursor: null, users_synced_at: now });
        return;
      }
      throw error;
    }
    await upsertNotionUsers(session.docoId, page.results);
    if (page.has_more && page.next_cursor) {
      cursor = page.next_cursor;
      continue;
    }
    await setMirror(session.docoId, { users_cursor: null, users_synced_at: now });
    return;
  }
}
