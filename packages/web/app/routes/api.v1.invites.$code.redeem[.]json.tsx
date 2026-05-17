// POST /api/v1/invites/<code>/redeem.json — single-use Invite redemption.
//
// Any user (agent or human) can redeem an Invite without prior auth.
// The server mints a fresh agent-Principal scoped to the inviting Doco,
// issues a SessionToken bound to that Doco (the redeemer's personal
// `DOCO_KEY`), and marks the Invite as consumed.
//
// For human redemption via the browser, see /invite/<code> (the web
// landing page wires through to this same redeem operation but
// associates the redeemer with the signed-in human Principal).
//
// Input: empty body, OR optional `{ display_name?, hostname? }`.
//
// Output:
//   {
//     doco_id: string,
//     doco_url: string,
//     doco_slug: string,
//     doco_key: string,            // .env as DOCO_KEY=<hex>
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
import { rootDir } from "~/lib/db.server";
import { addAgentPrincipal } from "~/lib/redeem.server";
import { getDocoById } from "@doco/db";

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
  // Phase 1 of slug-removal: prefer the handle URL; fall back to
  // /by-id/<ULID>/ for pre-handle Docos.
  const handle = doco.handle || `${doco.owner_slug}-${doco.doco_slug}`;
  const docoUrl = doco.handle ? `${origin}/${doco.handle}/` : `${origin}/by-id/${doco.id}/`;
  return Response.json({
    doco_id: doco.id,
    doco_handle: handle,
    doco_url: docoUrl,
    doco_slug: `${doco.owner_slug}/${doco.doco_slug}`,
    doco_key: session.token,
    /**
     * Next-step guidance for the redeeming agent — what to do with the
     * fields above before treating itself as "connected."
     */
    next_steps_for_agent: [
      "Write DOCO_KEY=<doco_key> to ./.env (gitignored — create the file and a basic .gitignore if either is missing).",
      "If doco.md doesn't already exist at repo root, write it with the doco_url so future clones / CI / teammates discover the Doco.",
      "If AGENTS.md doesn't include `@./doco.md`, add the line near the top.",
      "If CLAUDE.md doesn't exist, write it with the single line `@./AGENTS.md`.",
      "Fetch the canonical protocol: curl -fsS https://doco.to/agent/${DOCO_KEY}/bootstrap.json — apply it from your next reply.",
      "Render the user_message_block below as your next message to whoever invited you in.",
    ],
    /**
     * Verbatim block the agent renders to the user who pasted the
     * invite URL. Mirrors the create-side block: tells the user the
     * agent is now connected, names what just happened, and points
     * them at the human-friendly Doco URL for browsing.
     */
    user_message_block: [
      `✅ I claimed access to **${doco.owner_slug}/${doco.doco_slug}** (Doco at ${docoUrl}).`,
      ``,
      `I saved my personal access key to \`./.env\` (gitignored) — from here I fetch the protocol on session start, search prior decisions before drafting new ones, and capture meaningful changes as Doco nodes.`,
      ``,
      `If this repo didn't already have a \`doco.md\`, I just wrote one so future clones / CI / teammates discover the Doco. The key in \`.env\` is mine alone — if you want your own access (browse on the web, mint invites for teammates), ask me for a fresh invite URL.`,
    ].join("\n"),
  });
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
