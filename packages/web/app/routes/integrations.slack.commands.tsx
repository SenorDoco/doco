import {
  buildSlackConnectCommandResponse,
  parseSlackCommandPayload,
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

  const payload = parseSlackCommandPayload(rawBody);
  if (!payload.team_id || !payload.channel_id) {
    return Response.json({
      response_type: "ephemeral",
      text: "Slack did not include a workspace and channel for this command.",
    });
  }
  return Response.json(buildSlackConnectCommandResponse(request, payload));
}

export async function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
