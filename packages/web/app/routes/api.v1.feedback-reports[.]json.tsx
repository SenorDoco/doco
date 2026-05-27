import {
  createFeedbackReport,
  parseFeedbackReportInput,
  serverContextFromRequest,
} from "~/lib/feedback-reports.server";
import { getCurrentPrincipal } from "~/lib/session.server";

function parseJsonField(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string" || !value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

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
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      payload = {
        report_type: form.get("report_type"),
        title: form.get("title"),
        body: form.get("body"),
        expected: form.get("expected"),
        actual: form.get("actual"),
        severity: form.get("severity"),
        page_url: form.get("page_url"),
        route_path: form.get("route_path"),
        client_context: parseJsonField(form.get("client_context")),
        data: parseJsonField(form.get("data")),
      };
    }
  } catch {
    return Response.json({ error: "invalid_request_body" }, { status: 400 });
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
