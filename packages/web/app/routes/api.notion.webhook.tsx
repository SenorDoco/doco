// Inbound Notion webhook. One subscription on the public integration covers
// every workspace that authorized it, so every mirror's events land here.
//
// Two kinds of delivery:
//   - the subscription handshake: a body with only `verification_token`, sent
//     once when the subscription is created. That token is the secret every
//     later delivery is signed with; it is logged so the operator can set
//     DOCO_NOTION_WEBHOOK_SECRET (and paste it back into Notion's settings);
//   - an event, signed in X-Notion-Signature. It is applied to the mirror
//     tables BEFORE the ack (lib/notion-mirror.server.ts), so a failed write
//     answers 500 and Notion redelivers (up to 8 times over about a day).
// Events only flag pages; the sync reads the content back from Notion.
import { verifyNotionSignature } from "~/lib/notion-api.server";
import { mirrorNotionEvent } from "~/lib/notion-mirror.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const rawBody = await request.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json_body" }, { status: 400 });
  }
  const signature = request.headers.get("x-notion-signature");
  if (!signature && typeof payload.verification_token === "string") {
    console.info(
      `[notion webhook] subscription handshake: set DOCO_NOTION_WEBHOOK_SECRET to ${payload.verification_token}`,
    );
    return Response.json({ ok: true, handshake: true });
  }
  const secret = process.env.DOCO_NOTION_WEBHOOK_SECRET ?? "";
  if (!verifyNotionSignature({ rawBody, signature, secret })) {
    console.warn(
      `[notion webhook] signature rejected (DOCO_NOTION_WEBHOOK_SECRET configured: ${Boolean(secret)})`,
    );
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }
  try {
    const { docoIds } = await mirrorNotionEvent(payload);
    return Response.json({ ok: true, matched: docoIds.length });
  } catch (error) {
    console.error("[notion webhook] mirror write failed:", (error as Error).message);
    return Response.json({ error: "mirror_write_failed" }, { status: 500 });
  }
}
