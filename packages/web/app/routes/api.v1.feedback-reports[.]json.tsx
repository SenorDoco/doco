import {
  createFeedbackReport,
  parseFeedbackReportInput,
  serverContextFromRequest,
} from "~/lib/feedback-reports.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const input = parseFeedbackReportInput(payload);
  if ("error" in input) {
    return Response.json({ error: input.error }, { status: 400 });
  }

  const report = await createFeedbackReport({
    input,
    createdBy: me.id,
    createdByUsername: me.username,
    serverContext: serverContextFromRequest(request),
  });

  return Response.json({ ok: true, report }, { status: 201 });
}

export async function loader() {
  return Response.json(
    { error: "method_not_allowed", hint: "POST a bug or idea report." },
    { status: 405 },
  );
}
