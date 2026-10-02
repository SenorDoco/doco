// Sends the activity digest (lib/activity-digest.ts) to every member of each
// workspace that has one due, unless they unsubscribed from that workspace's
// or it is their personal workspace. Each member's numbers cover only the
// Docos they may read, as the workspace page shows them. A workspace's
// `digest_sent_at` is claimed before sending, so two runs at the same hour
// never both send it.
//
// The unsubscribe link carries the workspace and member encrypted (lib/
// secret-box.server.ts), so it works with one click and without signing in.

import { DIGEST_TOP_LIMIT, digestDue, digestEmail, digestPeriod } from "./activity-digest";
import { summarizeActivity } from "./activity-log.server";
import { listReadableDocosInWorkspace } from "./doco-access.server";
import { sendEmail } from "./email.server";
import { decryptSecret, encryptSecret } from "./secret-box.server";

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

export interface Membership {
  workspaceId: string;
  userId: string;
}

export function unsubscribeToken(m: Membership): string {
  return encryptSecret(JSON.stringify([m.workspaceId, m.userId]));
}

/** The membership an unsubscribe link names, or null if it was tampered with. */
export function readUnsubscribeToken(token: string): Membership | null {
  try {
    const [workspaceId, userId] = JSON.parse(decryptSecret(token)) as unknown[];
    if (typeof workspaceId !== "string" || typeof userId !== "string") return null;
    return { workspaceId, userId };
  } catch {
    return null;
  }
}

/** Turns a member's digest for one workspace on or off. Returns the
 *  workspace's handle, or null when they are no longer a member. */
export async function setDigestSubscription(
  c: QueryClient,
  m: Membership,
  subscribed: boolean,
): Promise<string | null> {
  const { rows } = await c.query<{ handle: string }>(
    `UPDATE workspace_users wu
        SET digest_unsubscribed_at =
              CASE WHEN $3 THEN NULL ELSE COALESCE(wu.digest_unsubscribed_at, now()) END
       FROM workspaces w
      WHERE w.id = wu.workspace_id AND wu.workspace_id = $1 AND wu.user_id = $2
      RETURNING w.handle`,
    [m.workspaceId, m.userId, subscribed],
  );
  return rows[0]?.handle ?? null;
}

/** Whether a member gets a workspace's digest, or null when they are no
 *  longer a member. */
export async function loadDigestSubscription(
  c: QueryClient,
  m: Membership,
): Promise<{ workspaceHandle: string; subscribed: boolean } | null> {
  const { rows } = await c.query<{ handle: string; subscribed: boolean }>(
    `SELECT w.handle, wu.digest_unsubscribed_at IS NULL AS subscribed
       FROM workspace_users wu JOIN workspaces w ON w.id = wu.workspace_id
      WHERE wu.workspace_id = $1 AND wu.user_id = $2`,
    [m.workspaceId, m.userId],
  );
  const row = rows[0];
  return row ? { workspaceHandle: row.handle, subscribed: row.subscribed } : null;
}

/** Sends every digest due at the hour `now` falls in. */
export async function sendActivityDigests(
  c: QueryClient,
  now: Date,
  baseUrl: string,
): Promise<{ workspaces: number; sent: number }> {
  const at = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const workspaces = (
    await c.query<{ id: string; handle: string; created_at: Date | string }>(
      "SELECT id, handle, created_at FROM workspaces",
    )
  ).rows;
  let claimed = 0;
  let sent = 0;
  for (const w of workspaces) {
    const due = digestDue(new Date(w.created_at), at);
    if (!due) continue;
    const claim = await c.query(
      `UPDATE workspaces SET digest_sent_at = $2
        WHERE id = $1 AND (digest_sent_at IS NULL OR digest_sent_at < $2)
        RETURNING id`,
      [w.id, at.toISOString()],
    );
    if (claim.rows.length === 0) continue;
    claimed += 1;
    const members = (
      await c.query<{ user_id: string; email: string }>(
        `SELECT u.id AS user_id, u.email
           FROM workspace_users wu JOIN users u ON u.id = wu.user_id
          WHERE wu.workspace_id = $1
            AND wu.digest_unsubscribed_at IS NULL
            AND u.deactivated_at IS NULL
            AND COALESCE(u.email, '') <> ''
            AND lower(u.github_login) IS DISTINCT FROM lower($2)`,
        [w.id, w.handle],
      )
    ).rows;
    for (const m of members) {
      const docos = await listReadableDocosInWorkspace(w.id, m.user_id);
      const summary = await summarizeActivity(
        c,
        { docoIds: docos.map((d) => d.id), workspaceId: w.id },
        digestPeriod(due, at),
        DIGEST_TOP_LIMIT,
      );
      const token = unsubscribeToken({ workspaceId: w.id, userId: m.user_id });
      const message = digestEmail({
        baseUrl,
        workspaceHandle: w.handle,
        due,
        summary,
        unsubscribeUrl: `${baseUrl}/digest/unsubscribe?${new URLSearchParams({ t: token })}`,
      });
      if ((await sendEmail({ to: m.email, ...message })).sent) sent += 1;
    }
  }
  return { workspaces: claimed, sent };
}
