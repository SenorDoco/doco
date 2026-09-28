// The Notion mirror's live path: apply one Notion webhook event to the mirror
// tables (schema.sql → "Notion mirror"), and the row writes the sync shares.
//
// An event is a signal, never content: Notion says deliveries can arrive out
// of order and behind the page's current state, so an event flags the page
// for a fetch (`fetch_pending`), and the sync's drain reads the page back from
// Notion. The one direct write is a deletion, which is real. Every write is
// idempotent (Notion redelivers), and the primary key collapses a burst of
// events for one page into one fetch.
import { withClient } from "@doco/db";
import { normalizeNotionId, notionPageUrl } from "./notion-markdown";

type Json = Record<string, unknown>;

export type NotionObjectKind = "page" | "data_source";
export type NotionFetchReason = "discover" | "reconcile" | "webhook" | "schema" | "retry";

/** The mirroring Docos an event for `workspaceId` belongs to. A public
 *  integration's events name the bots that can reach the entity, which is the
 *  precise key; without it, every mirror of the workspace. Deleted Docos are
 *  skipped. */
export async function findNotionMirrorDocoIds(
  workspaceId: string,
  botIds: string[] | null,
): Promise<string[]> {
  const r = await withClient((c) =>
    c.query<{ doco_id: string }>(
      `SELECT m.doco_id
         FROM notion_mirrors m
         JOIN docos d ON d.id = m.doco_id
        WHERE m.workspace_id = $1 AND d.deleted_at IS NULL
          AND ($2::text[] IS NULL OR m.bot_id = ANY($2::text[]))
        ORDER BY m.created_at`,
      [workspaceId, botIds],
    ),
  );
  return r.rows.map((row) => row.doco_id);
}

/** Apply a webhook delivery to every mirror it concerns. Returns those Docos. */
export async function mirrorNotionEvent(event: Json): Promise<{ docoIds: string[] }> {
  const type = str(event.type);
  const workspaceId = str(event.workspace_id);
  if (!type || !workspaceId) return { docoIds: [] };
  const botIds = accessibleBotIds(event.accessible_by);
  const docoIds = await findNotionMirrorDocoIds(workspaceId, botIds.length > 0 ? botIds : null);
  const entityId = normalizeNotionId(str(asJson(event.entity).id));
  const data = asJson(event.data);
  for (const docoId of docoIds) await applyNotionEvent(docoId, type, entityId, data);
  return { docoIds };
}

function accessibleBotIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asJson(entry))
    .filter((entry) => entry.type === "bot" && typeof entry.id === "string")
    .map((entry) => String(entry.id));
}

async function applyNotionEvent(
  docoId: string,
  type: string,
  entityId: string | null,
  data: Json,
): Promise<void> {
  const [family, action] = type.split(".");
  if (family === "comment") {
    const pageId = normalizeNotionId(str(data.page_id));
    if (pageId) await flagNotionPage(docoId, pageId, "page", "webhook");
    return;
  }
  const object = notionObjectKind(family);
  if (!object || !entityId) return;
  switch (action) {
    case "deleted":
      return deleteNotionPage(docoId, entityId);
    case "locked":
    case "unlocked":
      return;
    case "schema_updated":
      // Renamed or retyped properties change every row's rendered property block.
      await flagNotionPage(docoId, entityId, object, "webhook", parentOf(data));
      return flagNotionChildren(docoId, entityId, "schema");
    default:
      return flagNotionPage(docoId, entityId, object, "webhook", parentOf(data));
  }
}

/** The mirror's object kind for an event family or entity type: `page`, or
 *  `data_source` (a database's table; Notion's older `database` events name
 *  the same thing). */
export function notionObjectKind(type: string): NotionObjectKind | null {
  if (type === "page") return "page";
  if (type === "data_source" || type === "database") return "data_source";
  return null;
}

export interface NotionParentRef {
  parentId: string | null;
  parentType: string | null;
}

/** The parent an event or object names: a page or data source id, or the
 *  workspace root (`space` in events, `workspace` on objects). */
export function parentOf(data: Json): NotionParentRef {
  const parent = asJson(data.parent);
  const type = str(parent.type);
  if (!type) return { parentId: null, parentType: null };
  if (type === "space" || type === "workspace") return { parentId: null, parentType: "workspace" };
  const key = type.endsWith("_id") ? type : `${type}_id`;
  const id = normalizeNotionId(str(parent[key]) || str(parent.id));
  return { parentId: id, parentType: key.replace(/_id$/, "") };
}

/**
 * Insert the object as a stub, or flag the existing row, for the drain to
 * fetch. A parent named by the event is recorded; one it doesn't name is kept.
 */
export async function flagNotionPage(
  docoId: string,
  pageId: string,
  object: NotionObjectKind,
  reason: NotionFetchReason,
  parent: NotionParentRef = { parentId: null, parentType: null },
): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO notion_pages
         (doco_id, page_id, object, parent_id, parent_type, url, fetch_pending, fetch_reason)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)
       ON CONFLICT (doco_id, page_id) DO UPDATE SET
         fetch_pending = true,
         fetch_reason = EXCLUDED.fetch_reason,
         fetch_attempts = 0,
         fetch_error = NULL,
         parent_id = COALESCE(EXCLUDED.parent_id, notion_pages.parent_id),
         parent_type = COALESCE(EXCLUDED.parent_type, notion_pages.parent_type)`,
      [docoId, pageId, object, parent.parentId, parent.parentType, notionPageUrl(pageId), reason],
    ),
  );
}

/** Flag every row under a page or data source (a schema change re-renders
 *  each row's property block). */
export async function flagNotionChildren(
  docoId: string,
  parentId: string,
  reason: NotionFetchReason,
): Promise<void> {
  await withClient((c) =>
    c.query(
      `UPDATE notion_pages
          SET fetch_pending = true, fetch_reason = $3, fetch_attempts = 0, fetch_error = NULL
        WHERE doco_id = $1 AND parent_id = $2`,
      [docoId, parentId, reason],
    ),
  );
}

/** Trashed, unshared, or gone in Notion: delete the copy, and the copies of
 *  everything beneath it (Notion trashes a page's subpages with it). */
export async function deleteNotionPage(docoId: string, pageId: string): Promise<void> {
  await withClient((c) =>
    c.query(
      `WITH RECURSIVE gone AS (
         SELECT page_id FROM notion_pages WHERE doco_id = $1 AND page_id = $2
         UNION
         SELECT p.page_id FROM notion_pages p JOIN gone g ON p.parent_id = g.page_id
          WHERE p.doco_id = $1
       )
       DELETE FROM notion_pages
        WHERE doco_id = $1 AND page_id IN (SELECT page_id FROM gone)`,
      [docoId, pageId],
    ),
  );
}

/** Insert or refresh Notion people from user objects, in one write. */
export async function upsertNotionUsers(docoId: string, users: Json[]): Promise<void> {
  const rows = users.flatMap((user) => {
    const id = str(user.id);
    if (!id) return [];
    return [
      {
        id,
        name: str(user.name),
        avatarUrl: str(user.avatar_url) || null,
        isBot: user.type === "bot",
      },
    ];
  });
  if (rows.length === 0) return;
  await withClient((c) =>
    c.query(
      `INSERT INTO notion_users (doco_id, user_id, name, avatar_url, is_bot)
       SELECT $1, u.* FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[]) AS u
       ON CONFLICT (doco_id, user_id) DO UPDATE SET
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         is_bot = EXCLUDED.is_bot`,
      [
        docoId,
        rows.map((r) => r.id),
        rows.map((r) => r.name),
        rows.map((r) => r.avatarUrl),
        rows.map((r) => r.isBot),
      ],
    ),
  );
}

export function asJson(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
