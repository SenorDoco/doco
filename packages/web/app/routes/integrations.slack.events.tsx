import {
  listSlackChannelConnections,
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

  if (payload.type === "event_callback" && payload.event?.type === "app_mention") {
    const teamId = payload.team_id;
    const channelId = payload.event.channel;
    if (teamId && channelId && !payload.event.bot_id && !payload.event.subtype) {
      const connections = await listSlackChannelConnections({
        workspaceId: teamId,
        channelId,
      });
      const text =
        connections.length > 0
          ? `This channel is connected to ${connections
              .map((connection) => `${connection.targetLabel} as ${connection.role}`)
              .join(", ")}. Personal account linking comes next.`
          : "I’m installed here. Run `/doco connect` in this channel to choose the Doco and default access.";
      await postSlackMessage({ workspaceId: teamId, channelId, text });
    }
  }

  return Response.json({ ok: true });
}

export async function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
