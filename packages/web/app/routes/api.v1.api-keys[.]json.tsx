// /api/v1/api-keys.json — JSON API for access tokens.
//
// Companion to /api/v1/users/invite.json. That endpoint mints
// human invites; this one mints long-lived Bearer tokens. Splitting
// the two means API consumers don't have to encode "is this a human
// or an agent?" in a single endpoint's shape.
//
// GET    — list active access tokens for the signed-in user.
// POST   — mint a new access token. Body shape:
//            { label: string, grants: [{ level, target_id, role }] }
//          Returns the token bodies + client_id ONCE; subsequent GETs
//          return only metadata. Refresh tokens are non-rotating, so
//          DOCO_REFRESH + DOCO_CLIENT_ID can be pinned as env vars.
// DELETE — revoke a token by client_id. Pass ?client_id=... in the URL.
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
import { listApiKeysForUser, mintApiKey, revokeApiKey } from "~/lib/api-keys.server";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return Response.json({ error: "authentication_required" }, { status: 401 });
  }
  const keys = await listApiKeysForUser(me.id);
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
      body = (await request.json()) as {
        label?: unknown;
        grants?: unknown;
      };
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
          hint: "Pass { grants: [{ level: 'workspace'|'doco', target_id, role }] }.",
        },
        { status: 400 },
      );
    }

    const grants: Array<{
      level: "account" | "workspace" | "doco";
      target_id: string;
      role: DocoRole;
      write_types?: string[];
    }> = [];
    for (const raw of body.grants) {
      if (raw === null || typeof raw !== "object") {
        return Response.json({ error: "invalid_grant_entry" }, { status: 400 });
      }
      const r = raw as {
        level?: unknown;
        target_id?: unknown;
        role?: unknown;
        write_types?: unknown;
      };
      const level =
        r.level === "account" || r.level === "workspace" || r.level === "doco" ? r.level : null;
      const target_id = typeof r.target_id === "string" ? r.target_id : null;
      const role = typeof r.role === "string" ? (r.role as DocoRole) : null;
      // Account grants carry no target_id (the minter's whole account).
      if (!level || !role || (level !== "account" && !target_id)) {
        return Response.json(
          {
            error: "invalid_grant_entry",
            hint: "Each grant needs level + role; workspace/doco grants also need target_id.",
          },
          { status: 400 },
        );
      }
      // Optional per-type write scope (decision_per_type_write_grants):
      // an array of node/edge type tokens, or ["*"] for all.
      const write_types = Array.isArray(r.write_types)
        ? r.write_types.filter((t): t is string => typeof t === "string")
        : undefined;
      grants.push({ level, target_id: target_id ?? "", role, write_types });
    }

    try {
      const minted = await mintApiKey({ me, label, grants });
      return Response.json(
        {
          access_token: minted.access_token,
          refresh_token: minted.refresh_token,
          client_id: minted.client_id,
          expires_in: minted.expires_in,
          token_type: "Bearer",
          client_name: minted.client_name,
          scope_grants: minted.scope_grants,
        },
        { status: 201 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to mint token.";
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
    const revoked = await revokeApiKey({ user_id: me.id, client_id: clientId });
    return Response.json({ revoked });
  }

  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
