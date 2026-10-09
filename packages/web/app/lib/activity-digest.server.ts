// Sends the activity digest (lib/activity-digest.ts) to every member of each
// workspace, daily or, for who switched it to weekly, on Mondays, unless they
// unsubscribed, it is their personal workspace (workspaces.personal_user_id),
// or nothing happened in its period. Each member's numbers, and the top three
// it opens with, cover only the Docos they may read, as the workspace page
// shows them. A workspace's `digest_sent_at` is claimed before sending, so two
// runs at the same hour never both send it.
//
// The digest's links (/digest/daily, /digest/weekly, /digest/unsubscribe)
// carry the workspace and member encrypted (lib/secret-box.server.ts), so each
// works with one click and without signing in.

import {
  type Cadence,
  DIGEST_TOP_LIMIT,
  type DigestSetting,
  type TopItem,
  digestEmail,
  digestPeriod,
  settingsDue,
} from "./activity-digest";
import { summarizeActivity } from "./activity-log.server";
import { rankTopItems } from "./digest-top-three.server";
import { listReadableDocosInWorkspace } from "./doco-access.server";
import { sendEmail } from "./email.server";
import { decryptSecret, encryptSecret } from "./secret-box.server";

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

export interface Membership {
  workspaceId: string;
  userId: string;
}

export function digestToken(m: Membership): string {
  return encryptSecret(JSON.stringify([m.workspaceId, m.userId]));
}

/** The membership a digest link names, or null if it was tampered with. */
export function readDigestToken(token: string): Membership | null {
  try {
    const [workspaceId, userId] = JSON.parse(decryptSecret(token)) as unknown[];
    if (typeof workspaceId !== "string" || typeof userId !== "string") return null;
    return { workspaceId, userId };
  } catch {
    return null;
  }
}

/** Sets how often a member gets a workspace's digest. Returns the
 *  workspace's handle, or null when they are no longer a member. */
export async function setDigest(
  c: QueryClient,
  m: Membership,
  setting: DigestSetting,
): Promise<string | null> {
  const { rows } = await c.query<{ handle: string }>(
    `UPDATE workspace_users wu SET digest = $3
       FROM workspaces w
      WHERE w.id = wu.workspace_id AND wu.workspace_id = $1 AND wu.user_id = $2
      RETURNING w.handle`,
    [m.workspaceId, m.userId, setting],
  );
  return rows[0]?.handle ?? null;
}

/** Sends every digest due at the hour `now` falls in. */
export async function sendActivityDigests(
  c: QueryClient,
  now: Date,
  baseUrl: string,
): Promise<{ workspaces: number; sent: number }> {
  const at = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const due = settingsDue(at);
  const workspaces = (
    await c.query<{ id: string; handle: string; personal_user_id: string | null }>(
      "SELECT id, handle, personal_user_id FROM workspaces WHERE created_at < $1",
      [at.toISOString()],
    )
  ).rows;
  const claimed: {
    w: (typeof workspaces)[number];
    members: { user_id: string; email: string; digest: Cadence }[];
  }[] = [];
  for (const w of workspaces) {
    const claim = await c.query(
      `UPDATE workspaces SET digest_sent_at = $2
        WHERE id = $1 AND (digest_sent_at IS NULL OR digest_sent_at < $2)
        RETURNING id`,
      [w.id, at.toISOString()],
    );
    if (claim.rows.length === 0) continue;
    const members = (
      await c.query<{ user_id: string; email: string; digest: Cadence }>(
        `SELECT u.id AS user_id, u.email, wu.digest
           FROM workspace_users wu JOIN users u ON u.id = wu.user_id
          WHERE wu.workspace_id = $1
            AND wu.digest = ANY($3)
            AND u.deactivated_at IS NULL
            AND COALESCE(u.email, '') <> ''
            AND u.id IS DISTINCT FROM $2`,
        [w.id, w.personal_user_id, due],
      )
    ).rows;
    claimed.push({ w, members });
  }
  // Each workspace's top three, ranked once for each digest its members get,
  // and every ranking at once, since each is a model call.
  const tops = new Map<string, TopItem[]>();
  await Promise.all(
    claimed.flatMap(({ w, members }) =>
      [...new Set(members.map((m) => m.digest))].map(async (cadence) => {
        tops.set(`${w.id} ${cadence}`, await rankTopItems(c, w.id, cadence, at, baseUrl));
      }),
    ),
  );
  let sent = 0;
  for (const { w, members } of claimed) {
    for (const m of members) {
      const docoIds = (await listReadableDocosInWorkspace(w.id, m.user_id)).map((d) => d.id);
      const summary = await summarizeActivity(
        c,
        { docoIds, workspaceId: w.id },
        digestPeriod(m.digest, at),
        DIGEST_TOP_LIMIT,
      );
      if (summary.queries + summary.writes + summary.imports === 0) continue;
      const top = (tops.get(`${w.id} ${m.digest}`) ?? [])
        .filter((i) => docoIds.includes(i.docoId))
        .slice(0, 3);
      const message = digestEmail({
        baseUrl,
        workspaceHandle: w.handle,
        setting: m.digest,
        summary,
        top,
        token: digestToken({ workspaceId: w.id, userId: m.user_id }),
      });
      if ((await sendEmail({ to: m.email, ...message })).sent) sent += 1;
    }
  }
  return { workspaces: claimed.length, sent };
}
