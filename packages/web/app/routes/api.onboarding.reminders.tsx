// GET|POST /api/onboarding/reminders — Vercel Cron, every minute. Fifteen
// minutes after someone creates a workspace (or joins one from an invite),
// emails them once if a step is still open: the steps left, or, when asking
// their agent is all that's left, the message to send it
// (lib/onboarding-emails.ts). A no-op until email is configured; reminders
// that came due less than a day earlier go out once it is.
// Auth: only Vercel Cron's `Authorization: Bearer <CRON_SECRET>`.
import { withClient } from "@doco/db";
import { emailBaseUrl, emailConfigured, sendEmail } from "~/lib/email.server";
import { reminderEmail } from "~/lib/onboarding-emails";
import { claimDueReminders } from "~/lib/onboarding.server";

export const config = { maxDuration: 60 };

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
  const headers = { "Cache-Control": "no-store" };
  if (!emailConfigured()) return Response.json({ ok: true, skipped: "no_email" }, { headers });
  const due = await withClient((c) => claimDueReminders(c, new Date()));
  const baseUrl = emailBaseUrl();
  let sent = 0;
  for (const { progress, email } of due) {
    if (!email) continue;
    const message = reminderEmail({
      baseUrl,
      workspaceHandle: progress.workspaceHandle,
      steps: progress.steps,
    });
    if ((await sendEmail({ to: email, ...message })).sent) sent += 1;
  }
  return Response.json({ ok: true, due: due.length, sent }, { headers });
}
