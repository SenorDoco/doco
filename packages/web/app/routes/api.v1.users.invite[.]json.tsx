// /api/v1/users/invite.json — JSON API for inviting human
// users to an workspace or a doco. The companion to
// /api/v1/api-keys.json (which mints agent / personal API keys).
//
// Splitting the two endpoints means API consumers don't have to encode
// "is this a human or an agent?" — the URL says it. An invite URL is
// browser-only: the recipient signs in with GitHub and clicks Accept.
// Agents go through OAuth (Recipe A / B) instead, and the resulting
// token shows up under /api/v1/api-keys.json.
//
// POST body:
//   { level: "workspace" | "doco", target_id: string, role?: DocoRole }
//
// Returns:
//   { invite_url, invite_expires_at, role, level, prompt }
//
// Errors:
//   401 — anonymous caller
//   400 — invalid level / missing target_id
//   403 — caller has no access to the workspace/doco, or tried to grant a
//         role higher than their own

import { buildHumanInvitePrompt } from "~/lib/invite-prompts";
import { getCurrentPrincipal } from "~/lib/session.server";
import { handleUserInviteAction } from "~/lib/users.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }

  let body: { level?: unknown; target_id?: unknown; role?: unknown } = {};
  try {
    body = (await request.json()) as {
      level?: unknown;
      target_id?: unknown;
      role?: unknown;
    };
  } catch {
    return Response.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const level = body.level === "workspace" || body.level === "doco" ? body.level : null;
  const target_id = typeof body.target_id === "string" ? body.target_id.trim() : "";
  const role = typeof body.role === "string" ? body.role : "writer";
  if (!level) {
    return Response.json(
      { error: "level_required", hint: "Pass level: 'workspace' or 'doco'." },
      { status: 400 },
    );
  }
  if (!target_id) {
    return Response.json(
      { error: "target_id_required", hint: "Pass the workspace or doco id." },
      { status: 400 },
    );
  }

  // Reuse the same action handler as the web form so the validation
  // and minting rules stay in one place.
  const formBody = new URLSearchParams();
  formBody.set("intent", "invite");
  formBody.set("level", level);
  formBody.set("target_id", target_id);
  formBody.set("role", role);
  const synthRequest = new Request(request.url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(request.headers.entries()),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody,
  });
  const result = await handleUserInviteAction(synthRequest);

  if ("error" in result) {
    const lower = result.error.toLowerCase();
    const status =
      lower.includes("don't have a role") ||
      lower.includes("cannot mint") ||
      lower.includes("cannot grant")
        ? 403
        : 400;
    return Response.json({ error: result.error }, { status });
  }

  return Response.json({
    invite_url: result.invite_url,
    invite_expires_at: result.invite_expires_at,
    role: result.role,
    level: result.level,
    prompt: buildHumanInvitePrompt(result.invite_url),
  });
}

export async function loader() {
  return Response.json(
    {
      error: "method_not_allowed",
      hint: "POST { level, target_id, role? } to mint a single-use human invite link.",
    },
    { status: 405 },
  );
}
