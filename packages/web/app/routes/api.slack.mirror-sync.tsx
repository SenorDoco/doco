import { listActiveSlackMirrors, runSlackMirrorTick } from "~/lib/slack-mirror-sync.server";
// /api/slack/mirror-sync — Vercel Cron, every minute: advance each Slack
// public-channel mirror's paced background sync (history backfill, thread
// replies, hourly channel/member refresh). See lib/slack-mirror-sync.server.ts.
//
// Auth: only Vercel Cron's `Authorization: Bearer <CRON_SECRET>`.
//
// DOCO_SLACK_MIRROR_CALLS_PER_MINUTE (default 1) is how many history and
// thread-replies calls each mirror may make per minute: 1 matches Slack's limit
// for apps not listed on its Marketplace; raise it once the app is listed.
import { getSlackBotToken } from "~/lib/slack.server";

// The hourly refresh can wait out Slack's limit on a big team's member list.
export const config = { maxDuration: 300 };

export async function loader({ request }: { request: Request }) {
  return run(request);
}
export async function action({ request }: { request: Request }) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const callsPerMinute = Number(process.env.DOCO_SLACK_MIRROR_CALLS_PER_MINUTE) || 1;
  const mirrors = [];
  for (const { docoId, teamId } of await listActiveSlackMirrors()) {
    try {
      const token = await getSlackBotToken(teamId);
      if (!token) continue;
      mirrors.push({ docoId, ...(await runSlackMirrorTick({ docoId, token, callsPerMinute })) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[slack mirror-sync] ${docoId} failed:`, message);
      mirrors.push({ docoId, error: message });
    }
  }
  return Response.json({ ok: true, mirrors }, { headers: { "Cache-Control": "no-store" } });
}
