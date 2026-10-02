// The one way Doco sends email: alerts, the onboarding's welcome and reminder
// messages, and the activity digest. It goes out through Resend's HTTPS API when
// RESEND_API_KEY is set, from DOCO_EMAIL_FROM (default
// "🔮 Doco <notifications@doco.to>"). Without the key nothing is sent and the
// caller is told so, which keeps tests and previews from mailing anyone.

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "🔮 Doco <notifications@doco.to>";

export interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, such as List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface EmailResult {
  sent: boolean;
  error?: string;
}

/** Whether email can go out at all (the provider's key is set). */
export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

/** Where links in emails point: the public site, never the deployment that
 *  happened to send them (a cron runs on a vercel.app host). */
export function emailBaseUrl(): string {
  return (process.env.DOCO_PUBLIC_HOST?.trim() || "https://doco.to").replace(/\/+$/, "");
}

export async function sendEmail(email: Email): Promise<EmailResult> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return { sent: false, error: "Email isn't configured: RESEND_API_KEY is unset." };
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: process.env.DOCO_EMAIL_FROM?.trim() || DEFAULT_FROM,
        to: [email.to],
        subject: email.subject,
        text: email.text,
        ...(email.html ? { html: email.html } : {}),
        ...(email.headers ? { headers: email.headers } : {}),
      }),
    });
    if (res.ok) return { sent: true };
    const error = `Resend refused the email (${res.status}): ${(await res.text()).slice(0, 300)}`;
    console.warn(`[email] ${error}`);
    return { sent: false, error };
  } catch (err) {
    const error = `Resend couldn't be reached: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[email] ${error}`);
    return { sent: false, error };
  }
}
