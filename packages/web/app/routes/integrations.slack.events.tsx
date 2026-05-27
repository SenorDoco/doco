import {
  buildSlackAppMentionResponse,
  fetchSlackConversationContext,
  postSlackMessage,
  verifySlackRequest,
} from "~/lib/slack.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const rawBody = await request.text();
  if (!(await verifySlackRequest(request, rawBody))) {
    return Response.json({ error: "invalid_slack_signature" }, { status: 401 });
  }
  if (isSlackRetryRequest(request)) {
    return Response.json({ ok: true });
  }

  let payload: {
    type?: string;
    challenge?: string;
    team_id?: string;
    event?: SlackEventPayload;
  };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    return Response.json({ error: "invalid_json_body" }, { status: 400 });
  }

  if (payload.type === "url_verification") {
    return Response.json({ challenge: payload.challenge ?? "" });
  }

  const event = payload.event;

  if (payload.type === "event_callback" && shouldReplyToSlackEvent(event)) {
    const teamId = payload.team_id;
    const channelId = event?.channel;
    if (teamId && channelId && !event?.bot_id && !event?.subtype) {
      const recentMessages = shouldFetchSlackConversationContext(event)
        ? await fetchSlackConversationContext({
            workspaceId: teamId,
            channelId,
            latestTs: event.ts,
          })
        : [];
      const text = await buildSlackAppMentionResponse({
        workspaceId: teamId,
        channelId,
        messageText: event?.text ?? "",
        recentMessages,
      });
      await postSlackMessage({ workspaceId: teamId, channelId, text });
    }
  }

  return Response.json({ ok: true });
}

export async function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}

interface SlackEventPayload {
  type?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  bot_id?: string;
  subtype?: string;
}

export function shouldReplyToSlackEvent(event: SlackEventPayload | undefined): boolean {
  if (event?.type === "app_mention") return true;
  if (event?.type !== "message") return false;
  return event.channel_type === "im" || event.channel_type === "app_home";
}

export function shouldFetchSlackConversationContext(event: SlackEventPayload | undefined): boolean {
  if (!event) return false;
  return event.channel_type === "im" || event.channel_type === "app_home";
}

export function isSlackRetryRequest(request: Request): boolean {
  return request.headers.has("x-slack-retry-num");
}
