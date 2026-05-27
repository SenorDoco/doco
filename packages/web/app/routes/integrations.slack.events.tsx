import {
  buildSlackAppMentionResponse,
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

  let payload: {
    type?: string;
    challenge?: string;
    team_id?: string;
    event?: {
      type?: string;
      channel?: string;
      channel_type?: string;
      user?: string;
      text?: string;
      bot_id?: string;
      subtype?: string;
    };
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
  const shouldReply =
    event?.type === "app_mention" || (event?.type === "message" && event.channel_type === "im");

  if (payload.type === "event_callback" && shouldReply) {
    const teamId = payload.team_id;
    const channelId = event?.channel;
    if (teamId && channelId && !event?.bot_id && !event?.subtype) {
      const text = await buildSlackAppMentionResponse({
        workspaceId: teamId,
        channelId,
        messageText: event?.text ?? "",
      });
      await postSlackMessage({ workspaceId: teamId, channelId, text });
    }
  }

  return Response.json({ ok: true });
}

export async function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
