// Sends the activity digest, each workspace's newspaper (lib/activity-digest.ts),
// to every member of each workspace at midnight Pacific Time: daily or, for
// who switched it to weekly, on Mondays, unless they unsubscribed or it is
// their personal workspace (workspaces.personal_user_id). It comes out on a
// quiet day too. Each member's numbers, and the stories it leads with, cover
// only the Docos they may read, as the workspace page shows them. A workspace's
// `digest_sent_at` is claimed before sending, so two runs at the same hour
// never both send it.
//
// The digest's links (/digest/daily, /digest/weekly, /digest/unsubscribe)
// carry the workspace and member encrypted (lib/secret-box.server.ts), so each
// works with one click and without signing in.

import {
  type Cadence,
  DIGEST_TOP_LIMIT,
  type DigestSetting,
  FRONT_PAGE_STORIES,
  type Story,
  digestEmail,
  digestPeriod,
  settingsDue,
  timesTitle,
} from "./activity-digest";
import { summarizeActivity } from "./activity-log.server";
import { listReadableDocosInWorkspace } from "./doco-access.server";
import { sendEmail } from "./email.server";
import { rankStories } from "./front-page.server";
import { mastheadUrl } from "./masthead.server";
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
 *  workspace's handle and its newspaper's title, or null when they are no
 *  longer a member. */
export async function setDigest(
  c: QueryClient,
  m: Membership,
  setting: DigestSetting,
): Promise<{ workspaceHandle: string; title: string } | null> {
  const { rows } = await c.query<{ handle: string; name: string }>(
    `UPDATE workspace_users wu SET digest = $3
       FROM workspaces w
      WHERE w.id = wu.workspace_id AND wu.workspace_id = $1 AND wu.user_id = $2
      RETURNING w.handle, w.name`,
    [m.workspaceId, m.userId, setting],
  );
  const w = rows[0];
  return w ? { workspaceHandle: w.handle, title: timesTitle(w.name) } : null;
}

/** Sends every edition due at the hour `now` falls in: none but at midnight
 *  Pacific Time. */
export async function sendActivityDigests(
  c: QueryClient,
  now: Date,
  baseUrl: string,
): Promise<{ workspaces: number; sent: number }> {
  const at = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const due = settingsDue(at);
  if (due.length === 0) return { workspaces: 0, sent: 0 };
  const workspaces = (
    await c.query<{ id: string; handle: string; name: string; personal_user_id: string | null }>(
      "SELECT id, handle, name, personal_user_id FROM workspaces WHERE created_at < $1",
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
  // Each workspace's stories, ranked once for each edition its members get,
  // and every ranking at once, since each is a model call.
  const ranked = new Map<string, Story[]>();
  await Promise.all(
    claimed.flatMap(({ w, members }) =>
      [...new Set(members.map((m) => m.digest))].map(async (cadence) => {
        ranked.set(`${w.id} ${cadence}`, await rankStories(c, w.id, cadence, at, baseUrl));
      }),
    ),
  );
  let sent = 0;
  for (const { w, members } of claimed) {
    const title = timesTitle(w.name);
    // One masthead for everyone's copy, so mail clients fetch it once.
    const masthead = mastheadUrl(baseUrl, title);
    for (const m of members) {
      const docoIds = (await listReadableDocosInWorkspace(w.id, m.user_id)).map((d) => d.id);
      const summary = await summarizeActivity(
        c,
        { docoIds, workspaceId: w.id },
        digestPeriod(m.digest, at),
        DIGEST_TOP_LIMIT,
      );
      const stories = (ranked.get(`${w.id} ${m.digest}`) ?? [])
        .filter((i) => docoIds.includes(i.docoId))
        .slice(0, FRONT_PAGE_STORIES);
      const message = digestEmail({
        baseUrl,
        workspaceHandle: w.handle,
        title,
        masthead,
        setting: m.digest,
        at,
        summary,
        stories,
        token: digestToken({ workspaceId: w.id, userId: m.user_id }),
      });
      if ((await sendEmail({ to: m.email, ...message })).sent) sent += 1;
    }
  }
  return { workspaces: claimed.length, sent };
}
