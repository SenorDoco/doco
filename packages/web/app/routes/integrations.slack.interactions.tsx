import { verifySlackRequest } from "~/lib/slack.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const rawBody = await request.text();
  if (!(await verifySlackRequest(request, rawBody))) {
    return Response.json({ error: "invalid_slack_signature" }, { status: 401 });
  }
  return Response.json({
    response_type: "ephemeral",
    text: "Open Doco to finish configuring Señor Doco.",
  });
}

export async function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
