// Visualization perspectives — server-side data access.
//
// Mirrors the doco-templates pattern: built-in perspectives ship with
// the framework (graph, list, bpmn), users can attach any of them to
// a Doco's overview page, and owners and writers can flip the default.
//
// Gating: read access follows the Doco's read gate (handled by the
// route's loadDocoForRead). Mutating operations (attach, detach,
// set-default) require writer-or-owner via canWriteDoco().
//
// Storage: see migrations/007_perspectives.sql.

import { withClient } from "@doco/db";

export type PerspectiveKind =
  | "graph"
  | "list"
  | "bpmn"
  | "org-tree"
  | "sla"
  | "approval"
  | "glossary"
  | "pull-requests";

export interface Perspective {
  id: string;
  slug: string;
  kind: PerspectiveKind;
  name: string;
  description: string | null;
  icon: string | null;
  ownerHandle: string | null;
  isBuiltin: boolean;
  config: Record<string, unknown>;
}

export interface AttachedPerspective extends Perspective {
  position: number;
  isDefault: boolean;
}

interface PerspectiveRow {
  id: string;
  slug: string;
  kind: PerspectiveKind;
  name: string;
  description: string | null;
  icon: string | null;
  owner_handle: string | null;
  is_builtin: boolean;
  config: unknown;
}

interface AttachedRow extends PerspectiveRow {
  position: number;
  is_default: boolean;
}

function rowToPerspective(row: PerspectiveRow): Perspective {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    name: row.name,
    description: row.description,
    icon: row.icon,
    ownerHandle: row.owner_handle,
    isBuiltin: row.is_builtin,
    config: (row.config as Record<string, unknown>) ?? {},
  };
}

/**
 * Perspectives attached to this Doco, in tab order. If nothing is
 * attached yet (e.g. a brand-new Doco that pre-dates the migration's
 * backfill), returns an empty list — the caller is expected to attach
 * the two ship-by-default perspectives via `ensureDefaultsAttached`.
 */
export async function listPerspectivesForDoco(docoId: string): Promise<AttachedPerspective[]> {
  return withClient(async (c) => {
    const { rows } = await c.query<AttachedRow>(
      `SELECT p.id, p.slug, p.kind, p.name, p.description, p.icon,
              p.owner_handle, p.is_builtin, p.config,
              dp.position, dp.is_default
        FROM doco_perspectives dp
         JOIN perspectives p ON p.id = dp.perspective_id
        WHERE dp.doco_id = $1
        ORDER BY dp.position ASC, LOWER(p.name) ASC`,
      [docoId],
    );
    return rows.map((r) => ({
      ...rowToPerspective(r),
      position: r.position,
      isDefault: r.is_default,
    }));
  });
}

/**
 * Idempotent: attach graph + list + approval defaults if this Doco has no
 * perspectives attached yet. Called from the index route loader so
 * Docos created before the migration ran still get tabs.
 */
export async function ensureDefaultsAttached(docoId: string): Promise<void> {
  await withClient(async (c) => {
    const { rows } = await c.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM doco_perspectives WHERE doco_id = $1",
      [docoId],
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await c.query(
      `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default)
            VALUES ($1, 'perspective_graph', 0, true)
       ON CONFLICT (doco_id, perspective_id) DO NOTHING`,
      [docoId],
    );
    await c.query(
      `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default)
            VALUES ($1, 'perspective_list', 1, false)
       ON CONFLICT (doco_id, perspective_id) DO NOTHING`,
      [docoId],
    );
    await c.query(
      `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default)
            VALUES ($1, 'perspective_approval', 2, false)
       ON CONFLICT (doco_id, perspective_id) DO NOTHING`,
      [docoId],
    );
  });
}

/**
 * Every perspective in the registry — what the picker page lists.
 * Today: builtins + nothing else. Future: user-created perspectives,
 * filtered by visibility.
 */
export async function listAvailablePerspectives(): Promise<Perspective[]> {
  return withClient(async (c) => {
    const { rows } = await c.query<PerspectiveRow>(
      `SELECT id, slug, kind, name, description, icon,
              owner_handle, is_builtin, config
         FROM perspectives
        ORDER BY LOWER(name) ASC`,
    );
    return rows.map(rowToPerspective);
  });
}

export async function getPerspectiveBySlug(slug: string): Promise<Perspective | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<PerspectiveRow>(
      `SELECT id, slug, kind, name, description, icon,
              owner_handle, is_builtin, config
         FROM perspectives
        WHERE slug = $1`,
      [slug],
    );
    const row = rows[0];
    return row ? rowToPerspective(row) : null;
  });
}

/**
 * Attach `perspectiveId` to `docoId` at the next position. Idempotent —
 * if already attached, returns silently. Caller must gate on
 * `canWriteDoco()`.
 */
export async function attachPerspectiveToDoco(args: {
  docoId: string;
  perspectiveId: string;
  attachedByUserId: string | null;
}): Promise<void> {
  await withClient(async (c) => {
    const { rows } = await c.query<{ next_position: string }>(
      `SELECT COALESCE(MAX(position) + 1, 0)::text AS next_position
         FROM doco_perspectives WHERE doco_id = $1`,
      [args.docoId],
    );
    const nextPosition = Number(rows[0]?.next_position ?? 0);
    await c.query(
      `INSERT INTO doco_perspectives (doco_id, perspective_id, position, is_default, attached_by_user)
            VALUES ($1, $2, $3, false, $4)
       ON CONFLICT (doco_id, perspective_id) DO NOTHING`,
      [args.docoId, args.perspectiveId, nextPosition, args.attachedByUserId],
    );
  });
}

/**
 * Detach a perspective from a Doco. Refuses to detach the current
 * default — the caller must promote a different tab first. Caller
 * must gate on `canWriteDoco()`.
 */
export async function detachPerspectiveFromDoco(args: {
  docoId: string;
  perspectiveId: string;
}): Promise<{ ok: boolean; error?: "is_default" | "not_attached" }> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ is_default: boolean }>(
      `SELECT is_default FROM doco_perspectives
        WHERE doco_id = $1 AND perspective_id = $2`,
      [args.docoId, args.perspectiveId],
    );
    if (rows.length === 0) return { ok: false, error: "not_attached" as const };
    if (rows[0].is_default) return { ok: false, error: "is_default" as const };
    await c.query("DELETE FROM doco_perspectives WHERE doco_id = $1 AND perspective_id = $2", [
      args.docoId,
      args.perspectiveId,
    ]);
    return { ok: true };
  });
}

/**
 * Mark one attached perspective as the Doco's default, unmarking any
 * previous default. Wrapped in a transaction so the partial-unique
 * `doco_perspectives_one_default` index never sees two true rows.
 * Caller must gate on `canWriteDoco()`.
 */
export async function setDefaultPerspective(args: {
  docoId: string;
  perspectiveId: string;
}): Promise<{ ok: boolean; error?: "not_attached" }> {
  return withClient(async (c) => {
    await c.query("BEGIN");
    try {
      const { rows } = await c.query<{ x: number }>(
        `SELECT 1 AS x FROM doco_perspectives
          WHERE doco_id = $1 AND perspective_id = $2`,
        [args.docoId, args.perspectiveId],
      );
      if (rows.length === 0) {
        await c.query("ROLLBACK");
        return { ok: false, error: "not_attached" as const };
      }
      await c.query(
        `UPDATE doco_perspectives SET is_default = false
          WHERE doco_id = $1 AND is_default = true`,
        [args.docoId],
      );
      await c.query(
        `UPDATE doco_perspectives SET is_default = true
          WHERE doco_id = $1 AND perspective_id = $2`,
        [args.docoId, args.perspectiveId],
      );
      await c.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });
}

/**
 * Resolve which perspective to render for an incoming request. Order
 * of preference:
 *   1. Explicit `?perspective=<slug>` query param (if attached).
 *   2. The Doco's default.
 *   3. The first attached perspective by position.
 *   4. null — no perspectives at all (caller should call
 *      `ensureDefaultsAttached` and retry).
 */
export function resolveActivePerspective(
  attached: AttachedPerspective[],
  requestedSlug: string | null,
): AttachedPerspective | null {
  if (attached.length === 0) return null;
  if (requestedSlug) {
    const match = attached.find((p) => p.slug === requestedSlug);
    if (match) return match;
  }
  const def = attached.find((p) => p.isDefault);
  if (def) return def;
  return attached[0];
}
