// POST /api/v1/invites/<code>/redeem.json — single-use Invite redemption.
//
// Any user (agent or human) can redeem an Invite without prior auth.
// The server mints a fresh agent-Principal scoped to the inviting Doco,
// issues an access credential bound to that Doco, and marks the Invite
// as consumed.
//
// For human redemption via the browser, see /invite/<code> (the web
// landing page wires through to this same redeem operation but
// associates the redeemer with the signed-in human Principal).
//
// Input: empty body, OR optional `{ display_name?, hostname? }`.
//
// Output shape is shared with the anonymous-create endpoint via
// `~/lib/agent-bootstrap-response.server` (see `BootstrapResponse`).
// Redeem-side responses omit the invite handoff fields:
//   {
//     doco_id: string,
//     doco_url: string,
//     doco_handle: string,
//     doco_access: string,         // .env as DOCO_ACCESS=<hex>
//     next_steps_for_agent: string[],
//     user_message_block: string,  // verbatim connection-confirmed block
//   }
//
// Errors:
//   404 not_found     — invite code doesn't exist
//   410 expired       — past expires_at
//   410 consumed      — single-use invite already redeemed
//   410 revoked       — invite was revoked by the minter

import { randomBytes } from "node:crypto";
import type { EntityId } from "@doco/shared";
import { TokenStore } from "~/lib/tokens.server";
import { docoPath, rootDir } from "~/lib/db.server";
import { addAgentPrincipal } from "~/lib/redeem.server";
import { getDocoById } from "@doco/db";
import { buildAgentBootstrapResponse } from "~/lib/agent-bootstrap-response.server";
import { loadBootstrapContext } from "~/lib/bootstrap-context.server";

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { code: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const code = (params.code ?? "").trim();
  if (!code) {
    return Response.json({ error: "missing_code" }, { status: 400 });
  }

  let body: { display_name?: string; hostname?: string } = {};
  try {
    body = (await request.json()) as { display_name?: string; hostname?: string };
  } catch {
    // Empty body is fine.
  }

  const store = TokenStore.forDoco(rootDir());
  const invite = await store.findInvite(code);
  if (!invite) {
    return Response.json({ status: "not_found" }, { status: 404 });
  }
  if (invite.status === "expired") {
    return Response.json({ status: "expired" }, { status: 410 });
  }
  if (invite.status === "consumed") {
    return Response.json({ status: "consumed" }, { status: 410 });
  }
  if (invite.status === "revoked") {
    return Response.json({ status: "revoked" }, { status: 410 });
  }

  const doco = await getDocoById(invite.doco_id);
  if (!doco) {
    return Response.json({ status: "doco_not_found" }, { status: 404 });
  }

  // Mint a per-redeemer agent-Principal. The redeemer's invitation
  // chain is rooted at whichever Principal minted the invite (the
  // creator agent, an existing collaborator, etc.) — null when the
  // minter itself had no owner.
  const isoNow = new Date().toISOString();
  const agentUsername = `agent-${randomBytes(6).toString("hex")}`;
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  const displayName = body.display_name?.trim() || `Invited agent ${agentUsername}`;
  let agentId: EntityId<"principal">;
  try {
    agentId = await addAgentPrincipal(rootDir(), {
      username: agentUsername,
      display_name: displayName,
      owner_id: invite.minted_by_principal_id,
      agent_metadata: {
        provider: userAgent,
        model: userAgent,
        capabilities: [],
        created_at: isoNow,
      },
    });
  } catch (e) {
    return Response.json(
      { error: `Failed to mint redeemer agent: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const session = await store.issueSessionToken(
    agentId,
    invite.minted_by_principal_id ?? undefined,
    invite.doco_id,
  );

  const consumed = await store.consumeInvite(code, agentId);
  if (!consumed) {
    // Race — another redeemer beat us. Revert the just-minted token
    // by revoking it so the Doco's token store doesn't accumulate
    // orphans.
    await store.revoke(session.token, false);
    return Response.json({ status: "consumed" }, { status: 410 });
  }

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  // Bundle the per-Doco bootstrap context so the agent doesn't need a
  // follow-on /api/v1/agent-bootstrap fetch right after this call —
  // see the agent-bootstrap-response.server file header for why that
  // pattern trips credential-exfil heuristics.
  const context = await loadBootstrapContext({
    docoDir: docoPath(doco.handle),
    docoId: doco.id,
    handle: doco.handle,
    baseUrl: origin,
  });

  // Response shape (doco coordinates + recipe + canonical_instructions +
  // user_message_block) is built by the same helper the anonymous-create
  // endpoint uses, so future tweaks to either flow propagate to the other.
  return Response.json(
    buildAgentBootstrapResponse({
      flow: "redeem",
      origin,
      doco: { id: doco.id, handle: doco.handle },
      accessToken: session.token,
      context,
    }),
  );
}

export async function loader() {
  return Response.json(
    {
      error: "method_not_allowed",
      hint: "POST { } to redeem an invite. Optionally include { display_name, hostname } in the body for the agent identity card.",
    },
    { status: 405 },
  );
}
