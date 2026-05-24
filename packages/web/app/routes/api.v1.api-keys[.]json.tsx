// /api/v1/api-keys.json — JSON API for personal API keys.
//
// Companion to /api/v1/collaborators/invite.json. That endpoint mints
// human invites; this one mints long-lived Bearer tokens. Splitting
// the two means API consumers don't have to encode "is this a human
// or an agent?" in a single endpoint's shape.
//
// GET    — list active API keys for the signed-in user.
// POST   — mint a new personal API key. Body shape:
//            { label: string, grants: [{ level, target_id, role }] }
//          Returns the access + refresh token bodies ONCE. Subsequent
//          GETs return only metadata.
// DELETE — revoke a key by client_id. Pass ?client_id=... in the URL.
//
// Auth: signed-in cookie OR Authorization: Bearer (with `owner` role
// somewhere in scope — to mint a key that grants OWNER you must hold
// owner yourself, enforced inside mintApiKey).
//
// Errors:
//   401 — anonymous caller
//   400 — malformed body / missing required fields
//   403 — caller tried to mint with a role they don't hold

import type { DocoRole } from "@doco/db";
import { listApiKeysForCollaborator, mintApiKey, revokeApiKey } from "~/lib/api-keys.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }
  const keys = await listApiKeysForCollaborator(me.id);
  return Response.json({ keys });
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }

  if (request.method === "POST") {
    let body: {
      label?: unknown;
      grants?: unknown;
    } = {};
    try {
      body = (await request.json()) as { label?: unknown; grants?: unknown };
    } catch {
      return Response.json({ error: "invalid_json_body" }, { status: 400 });
    }

    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) {
      return Response.json(
        { error: "label_required", hint: "Pass { label: <string> }." },
        { status: 400 },
      );
    }

    if (!Array.isArray(body.grants)) {
      return Response.json(
        {
          error: "grants_required",
          hint: "Pass { grants: [{ level: 'org'|'doco', target_id, role }] }.",
        },
        { status: 400 },
      );
    }

    const grants: Array<{ level: "org" | "doco"; target_id: string; role: DocoRole }> = [];
    for (const raw of body.grants) {
      if (raw === null || typeof raw !== "object") {
        return Response.json({ error: "invalid_grant_entry" }, { status: 400 });
      }
      const r = raw as { level?: unknown; target_id?: unknown; role?: unknown };
      const level = r.level === "org" || r.level === "doco" ? r.level : null;
      const target_id = typeof r.target_id === "string" ? r.target_id : null;
      const role = typeof r.role === "string" ? (r.role as DocoRole) : null;
      if (!level || !target_id || !role) {
        return Response.json(
          {
            error: "invalid_grant_entry",
            hint: "Each grant needs level, target_id, role.",
          },
          { status: 400 },
        );
      }
      grants.push({ level, target_id, role });
    }

    try {
      const minted = await mintApiKey({ me, label, grants });
      return Response.json(
        {
          access_token: minted.access_token,
          refresh_token: minted.refresh_token,
          expires_in: minted.expires_in,
          token_type: "Bearer",
          client_name: minted.client_name,
          scope_grants: minted.scope_grants,
        },
        { status: 201 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to mint API key.";
      const status = message.toLowerCase().includes("cannot grant") ? 403 : 400;
      return Response.json({ error: message }, { status });
    }
  }

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId) {
      return Response.json(
        { error: "client_id_required", hint: "Pass ?client_id=... in the URL." },
        { status: 400 },
      );
    }
    const revoked = await revokeApiKey({ collaborator_id: me.id, client_id: clientId });
    return Response.json({ revoked });
  }

  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
