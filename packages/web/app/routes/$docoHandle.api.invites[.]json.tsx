// POST /<doco-handle>/api/invites.json — mint a new invite for this
// Doco. Any user holding access to the Doco can call this.
//
// Input (application/json, all optional):
//   { expires_in_days?: number, role?: DocoRole }
//
// Output:
//   {
//     invite_url:        "https://<host>/invite/<code>",
//     invite_expires_at: "<ISO timestamp>",
//     code:              "<64-hex>",
//     role:              "owner|writer|reader",
//     doco_url:          "https://<host>/<handle>/",
//     human_prompt:      "<verbatim text to share with a human user>",
//     agent_prompt:      "<verbatim text to paste into an AI agent>"
//   }
//
// The invite URL itself is browser-only — the human recipient opens
// it, signs in with GitHub, clicks Accept. `agent_prompt` is the
// project owner's onboarding text for their AI agent: it points the
// agent at the OAuth recipe (/protocol/agent-oauth-recipe) and at
// the human-facing Device Flow approval page (/device). The agent
// doesn't redeem the invite URL — agents authenticate independently
// via OAuth.
//
// Errors:
//   404 — Doco not found, or caller doesn't have access
//   400 — invalid expires_in_days (must be 1..365)

import { type DocoRole, ROLE_RANK } from "@doco/db";
import type { EntityId } from "@doco/shared";
import {
  buildAgentInvitePrompt,
  buildHumanInvitePrompt,
} from "~/components/collaboration-invite-prompt";
import { rootDir } from "~/lib/db.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { InviteStore } from "~/lib/invite-store.server";

const ROLE_VALUES = new Set<DocoRole>(["owner", "writer", "reader"]);
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
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  // loadDocoRouteForRead resolves slug aliases (308s if needed), gates the
  // caller against the Doco's visibility, and returns the canonical
  // metadata. Any user with read access can mint an invite — the
  // permission boundary is "you can read this Doco" rather than
  // "you can admin it," because invites are how memberships grow.
  const { meta, me } = await loadDocoRouteForRead(request, params);
  if (!me) {
    // canAccessDoco may have let an anonymous caller pass for a public
    // Doco; minting invites still requires a Principal so we can
    // record minted_by_user_id on the invite row.
    return Response.json({ error: "anonymous_callers_cannot_mint_invites" }, { status: 403 });
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

  // Inviting a user grants access at or below the inviter's own role.
  // A reader may invite another reader; an author may invite readers or
  // authors; owners can grant the full set. The role cap keeps invites
  // from widening authority beyond what the caller personally holds.
  const parsedRole = parseRole(body.role);
  const inviterRole = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!inviterRole) {
    return Response.json(
      {
        error: "You do not hold a role on this doco.",
      },
      { status: 403 },
    );
  }
  const requestedRole: DocoRole =
    parsedRole ?? (ROLE_RANK[inviterRole] >= ROLE_RANK.writer ? "writer" : inviterRole);
  if (ROLE_RANK[requestedRole] > ROLE_RANK[inviterRole]) {
    return Response.json(
      {
        error: `Cannot mint a '${requestedRole}' invite — you only hold '${inviterRole}' on this doco. Pick a role at or below your own.`,
      },
      { status: 403 },
    );
  }

  const store = InviteStore.forDoco(rootDir());
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
  const docoUrl = meta.handle ? `${origin}/${meta.handle}/` : `${origin}/by-id/${meta.docoId}/`;
  const inviteUrl = `${origin}/invite/${invite.code}`;
  const recipeUrl = `${origin}/protocol/agent-oauth-recipe`;
  const deviceUrl = `${origin}/device`;
  return Response.json({
    invite_url: inviteUrl,
    invite_expires_at: invite.expires_at,
    code: invite.code,
    role: requestedRole,
    doco_url: docoUrl,
    human_prompt: buildHumanInvitePrompt(inviteUrl),
    agent_prompt: buildAgentInvitePrompt({ docoUrl, recipeUrl, deviceUrl }),
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
