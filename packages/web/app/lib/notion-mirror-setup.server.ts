// Turning a Doco into a Notion mirror, and managing it: the signed OAuth
// state the consent form mints, recording the mirror after Notion's
// authorization (tokens encrypted at rest), the status the mirror page shows,
// and stopping it. The copy itself is kept by the sync
// (lib/notion-mirror-sync.server.ts) and the webhook path
// (lib/notion-mirror.server.ts).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { withClient } from "@doco/db";
import { type NotionTokenResponse, getNotionConfig, notionAuthorizeUrl } from "./notion-api.server";
import { decryptSecret, encryptSecret } from "./secret-box.server";

export interface NotionOAuthState {
  docoId: string;
  /** The Doco's workspace when consent was given; the callback re-checks it. */
  workspaceId: string;
  /** The Doco user who consented; the callback must be them. */
  userId: string;
  nonce: string;
  issuedAt: number;
}

const STATE_TTL_MS = 60 * 60 * 1000;

function stateSignature(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Sign the state the callback trusts. The client secret doubles as the key:
 *  the flow can't exchange the code without it anyway. Pure. */
export function signNotionState(state: NotionOAuthState, key: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${stateSignature(payload, key)}`;
}

/** The state a callback carries, or null when unsigned, tampered with,
 *  malformed, or older than an hour. Pure given the clock. */
export function verifyNotionState(
  raw: string,
  key: string,
  nowMs = Date.now(),
): NotionOAuthState | null {
  const [payload, given, extra] = raw.split(".");
  if (!key || !payload || !given || extra !== undefined) return null;
  const expected = Buffer.from(stateSignature(payload, key));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let state: NotionOAuthState;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as NotionOAuthState;
  } catch {
    return null;
  }
  if (
    typeof state.docoId !== "string" ||
    typeof state.workspaceId !== "string" ||
    typeof state.userId !== "string" ||
    typeof state.nonce !== "string" ||
    !Number.isFinite(state.issuedAt)
  ) {
    return null;
  }
  if (nowMs - state.issuedAt > STATE_TTL_MS || state.issuedAt - nowMs > 60_000) return null;
  return {
    docoId: state.docoId,
    workspaceId: state.workspaceId,
    userId: state.userId,
    nonce: state.nonce,
    issuedAt: state.issuedAt,
  };
}

/** Where Notion sends the user back. Overridable for tunnels, as the GitHub
 *  sign-in's callback is. */
export function notionRedirectUri(request: Request): string {
  return (
    process.env.DOCO_NOTION_REDIRECT_URI ||
    `${new URL(request.url).origin}/integrations/notion/callback`
  );
}

/** The Notion authorization page (with its page picker) for turning this Doco
 *  into a mirror; null when Notion isn't configured on this host. */
export function buildNotionAuthorizeUrl(
  request: Request,
  args: { docoId: string; workspaceId: string; userId: string },
): string | null {
  const config = getNotionConfig();
  if (!config.configured) return null;
  const state = signNotionState(
    { ...args, nonce: randomBytes(16).toString("base64url"), issuedAt: Date.now() },
    config.clientSecret,
  );
  return notionAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: notionRedirectUri(request),
    state,
  });
}

export type EnableNotionMirrorResult =
  | { ok: true }
  | { ok: false; reason: "workspace_mirrored_elsewhere"; handle: string };

/**
 * Record that `docoId` mirrors the Notion workspace the tokens belong to,
 * authorized by `consentedBy`. The Doco must be private (the schema enforces
 * it) and a workspace feeds one mirror. Re-authorizing the same Doco replaces
 * its tokens; pointing it at a different workspace drops the old copy.
 */
export async function enableNotionMirror(args: {
  docoId: string;
  tokens: NotionTokenResponse;
  consentedBy: string;
  now?: Date;
}): Promise<EnableNotionMirrorResult> {
  const { tokens } = args;
  const owner = (tokens.owner.user ?? {}) as { name?: unknown; id?: unknown };
  const authorizedBy =
    typeof owner.name === "string" ? owner.name : typeof owner.id === "string" ? owner.id : null;
  return withClient(async (c) => {
    const other = await c.query<{ handle: string }>(
      `SELECT d.handle
         FROM notion_mirrors m JOIN docos d ON d.id = m.doco_id
        WHERE m.workspace_id = $1 AND m.doco_id <> $2`,
      [tokens.workspace_id, args.docoId],
    );
    if (other.rows[0]) {
      return { ok: false, reason: "workspace_mirrored_elsewhere", handle: other.rows[0].handle };
    }
    // A mirror re-pointed at another workspace starts over: its pages belong
    // to the old one.
    await c.query(
      `DELETE FROM notion_pages
        WHERE doco_id = $1
          AND EXISTS (SELECT 1 FROM notion_mirrors m
                       WHERE m.doco_id = $1 AND m.workspace_id <> $2)`,
      [args.docoId, tokens.workspace_id],
    );
    await c.query(
      `INSERT INTO notion_mirrors
         (doco_id, workspace_id, workspace_name, workspace_icon, bot_id, access_token,
          refresh_token, authorized_by, consented_by, consented_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (doco_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         workspace_name = EXCLUDED.workspace_name,
         workspace_icon = EXCLUDED.workspace_icon,
         bot_id = EXCLUDED.bot_id,
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         authorized_by = EXCLUDED.authorized_by,
         consented_by = EXCLUDED.consented_by,
         consented_at = EXCLUDED.consented_at,
         discovery_cursor = NULL,
         discovery_started_at = NULL,
         discovered_at = NULL,
         reconciled_at = NULL,
         next_at = NULL,
         needs_reauth_at = NULL`,
      [
        args.docoId,
        tokens.workspace_id,
        tokens.workspace_name ?? "",
        tokens.workspace_icon,
        tokens.bot_id,
        encryptSecret(tokens.access_token),
        tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
        authorizedBy,
        args.consentedBy,
        args.now ?? new Date(),
      ],
    );
    return { ok: true };
  });
}

/** The mirror's token pair, decrypted. Null when the Doco mirrors nothing. */
export async function getNotionTokens(
  docoId: string,
): Promise<{ accessToken: string; refreshToken: string | null } | null> {
  const r = await withClient((c) =>
    c.query<{ access_token: string; refresh_token: string | null }>(
      "SELECT access_token, refresh_token FROM notion_mirrors WHERE doco_id = $1",
      [docoId],
    ),
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    accessToken: decryptSecret(row.access_token),
    refreshToken: row.refresh_token ? decryptSecret(row.refresh_token) : null,
  };
}

/** Store a fresh token pair (Notion says to keep every pair it returns), and
 *  clear a reauthorization flag. */
export async function storeNotionTokens(
  docoId: string,
  tokens: { access_token: string; refresh_token: string | null },
): Promise<void> {
  await withClient((c) =>
    c.query(
      `UPDATE notion_mirrors
          SET access_token = $2, refresh_token = $3, needs_reauth_at = NULL
        WHERE doco_id = $1`,
      [
        docoId,
        encryptSecret(tokens.access_token),
        tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
      ],
    ),
  );
}

/** Notion no longer accepts the token (removed from the workspace, or the
 *  refresh was refused): the sync stops until an owner reconnects. */
export async function markNotionMirrorNeedsReauth(docoId: string): Promise<void> {
  await withClient((c) =>
    c.query(
      "UPDATE notion_mirrors SET needs_reauth_at = COALESCE(needs_reauth_at, now()) WHERE doco_id = $1",
      [docoId],
    ),
  );
}

/** Walk every shared page again on the next sync (a new discovery pass). */
export async function requestNotionResync(docoId: string): Promise<void> {
  await withClient((c) =>
    c.query(
      `UPDATE notion_mirrors
          SET discovered_at = NULL, discovery_cursor = NULL, discovery_started_at = NULL
        WHERE doco_id = $1`,
      [docoId],
    ),
  );
}

/** Stop mirroring: deletes the mirror and, by cascade, the whole copy. */
export async function stopNotionMirror(docoId: string): Promise<void> {
  await withClient((c) => c.query("DELETE FROM notion_mirrors WHERE doco_id = $1", [docoId]));
}

export interface NotionMirrorParkedPage {
  pageId: string;
  title: string;
  url: string;
  error: string;
}

export interface NotionMirrorStatus {
  workspaceName: string;
  workspaceIcon: string | null;
  authorizedBy: string | null;
  consentedAt: string;
  needsReauth: boolean;
  /** When the last discovery walk finished; null while the first is running. */
  discoveredAt: string | null;
  /** When the sync last ran for this mirror. */
  tickedAt: string | null;
  /** Objects discovered, copied at least once, and still waiting for a fetch. */
  pages: number;
  synced: number;
  pending: number;
  /** Pages the sync gave up on after repeated failures. */
  parked: NotionMirrorParkedPage[];
}

export async function loadNotionMirrorStatus(docoId: string): Promise<NotionMirrorStatus | null> {
  return withClient(async (c) => {
    const mirror = (
      await c.query<{
        workspace_name: string;
        workspace_icon: string | null;
        authorized_by: string | null;
        consented_at: Date | string;
        needs_reauth_at: Date | string | null;
        discovered_at: Date | string | null;
        ticked_at: Date | string | null;
      }>(
        `SELECT workspace_name, workspace_icon, authorized_by, consented_at, needs_reauth_at,
                discovered_at, ticked_at
           FROM notion_mirrors WHERE doco_id = $1`,
        [docoId],
      )
    ).rows[0];
    if (!mirror) return null;
    const counts = (
      await c.query<{ pages: number; synced: number; pending: number }>(
        `SELECT count(*)::int AS pages,
                count(*) FILTER (WHERE synced_at IS NOT NULL)::int AS synced,
                count(*) FILTER (WHERE fetch_pending)::int AS pending
           FROM notion_pages WHERE doco_id = $1`,
        [docoId],
      )
    ).rows[0];
    const parked = (
      await c.query<{ page_id: string; title: string; url: string; fetch_error: string }>(
        `SELECT page_id, title, url, fetch_error
           FROM notion_pages
          WHERE doco_id = $1 AND NOT fetch_pending AND fetch_error IS NOT NULL
          ORDER BY title, page_id
          LIMIT 50`,
        [docoId],
      )
    ).rows;
    return {
      workspaceName: mirror.workspace_name,
      workspaceIcon: mirror.workspace_icon,
      authorizedBy: mirror.authorized_by,
      consentedAt: new Date(mirror.consented_at).toISOString(),
      needsReauth: mirror.needs_reauth_at !== null,
      discoveredAt: mirror.discovered_at ? new Date(mirror.discovered_at).toISOString() : null,
      tickedAt: mirror.ticked_at ? new Date(mirror.ticked_at).toISOString() : null,
      pages: Number(counts?.pages ?? 0),
      synced: Number(counts?.synced ?? 0),
      pending: Number(counts?.pending ?? 0),
      parked: parked.map((row) => ({
        pageId: row.page_id,
        title: row.title,
        url: row.url,
        error: row.fetch_error,
      })),
    };
  });
}
