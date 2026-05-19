// POST /<doco-handle>/api/invites.json — mint a new invite for this
// Doco. Any user (agent or human) holding a valid access credential for the
// Doco can call this; auth flows through getCurrentPrincipalAsync,
// which resolves the URL-path credential, query-param credential, or
// Bearer header.
//
// Input (application/json, all optional):
//   { expires_in_days?: number, description?: string }
//
// Output:
//   {
//     invite_url:        "https://<host>/invite/<code>",
//     invite_expires_at: "<ISO timestamp>",
//     code:              "<64-hex>",
//     doco_url:          "https://<host>/by-id/<doco_id>/",
//   }
//
// Errors:
//   404 — Doco not found, or caller doesn't have access
//   400 — invalid expires_in_days (must be 1..365)

import type { EntityId } from "@doco/shared";
import { ROLE_RANK, type DocoRole } from "@doco/db";
import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";
import {
  getDocoLevelRole,
  loadDocoForRead,
  normalizeDocoParams,
} from "~/lib/doco-access.server";

const ROLE_VALUES = new Set<DocoRole>(["owner", "approver", "author", "reader"]);
function parseRole(v: unknown): DocoRole | null {
  return typeof v === "string" && ROLE_VALUES.has(v as DocoRole) ? (v as DocoRole) : null;
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  // loadDocoForRead resolves slug aliases (308s if needed), gates the
  // caller against the Doco's visibility, and returns the canonical
  // metadata. Any user with read access can mint an invite — the
  // permission boundary is "you can read this Doco" rather than
  // "you can admin it," because invites are how memberships grow.
  const { meta, me } = await loadDocoForRead(request, handle);
  if (!me) {
    // canAccessDoco may have let an anonymous caller pass for a public
    // Doco; minting invites still requires a Principal so we can
    // record minted_by_principal_id on the invite row.
    return Response.json(
      { error: "anonymous_callers_cannot_mint_invites" },
      { status: 403 },
    );
  }

  let body: { expires_in_days?: number; role?: string } = {};
  try {
    body = (await request.json()) as { expires_in_days?: number; role?: string };
  } catch {
    // Empty body is fine.
  }

  const ttlDays =
    typeof body.expires_in_days === "number" && Number.isFinite(body.expires_in_days)
      ? body.expires_in_days
      : 7;
  if (ttlDays < 1 || ttlDays > 365) {
    return Response.json(
      {
        error: "expires_in_days out of range",
        hint: "Pass an integer in [1, 365]. Omit to default to 7.",
      },
      { status: 400 },
    );
  }

  // Role to grant the redeemer (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
  // Default: `author`. Inviter must hold a doco-level role ≥ requested
  // role — you cannot mint a more-privileged grant than you yourself
  // hold. Org owners and doco-owners pass all checks; lower tiers can
  // only invite at-or-below their tier.
  const requestedRole: DocoRole = parseRole(body.role) ?? "author";
  const inviterRole = await getDocoLevelRole(
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
  );
  if (!inviterRole) {
    return Response.json(
      { error: "Only doco members can mint invites." },
      { status: 403 },
    );
  }
  if (ROLE_RANK[requestedRole] > ROLE_RANK[inviterRole]) {
    return Response.json(
      {
        error: `Cannot mint a '${requestedRole}' invite — you only hold '${inviterRole}' on this doco. Pick a role at or below your own.`,
      },
      { status: 403 },
    );
  }

  const store = TokenStore.forDoco(rootDir());
  const invite = await store.issueInvite(
    meta.docoId as EntityId<"doco">,
    me.id as EntityId<"principal">,
    Math.floor(ttlDays),
    requestedRole,
  );

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  // Phase 1 of slug-removal: prefer the handle URL; fall back to the
  // ULID /by-id/ form for pre-handle Docos.
  const docoUrl = meta.handle
    ? `${origin}/${meta.handle}/`
    : `${origin}/by-id/${meta.docoId}/`;
  return Response.json({
    invite_url: `${origin}/invite/${invite.code}`,
    invite_expires_at: invite.expires_at,
    code: invite.code,
    role: invite.role ?? requestedRole,
    doco_url: docoUrl,
  });
}

export async function loader() {
  return Response.json(
    {
      error: "method_not_allowed",
      hint: "POST { expires_in_days? } to mint a new invite. Defaults: single-use, 7-day expiration.",
    },
    { status: 405 },
  );
}
