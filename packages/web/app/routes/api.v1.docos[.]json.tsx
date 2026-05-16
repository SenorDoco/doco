// POST /api/v1/docos.json — anonymous Doco creation.
//
// Any user (agent or human) can call this with no prior auth. The
// server mints an anonymous agent-Principal as the owner-of-record,
// creates a new Doco under it, issues a SessionToken bound to that
// Doco (the creator's `DOCO_KEY`), and mints an initial 7-day Invite
// so the creator has a sharable URL on the same response.
//
// Input (application/json, all optional):
//   { slug?: string, description?: string }
//
// Output:
//   {
//     doco_id: string,
//     doco_url: string,            // https://<host>/by-id/<doco_id>/  — for doco.md
//     doco_slug: string,           // "<owner>/<slug>" canonical form
//     doco_key: string,            // for .env as DOCO_KEY=<hex>
//     invite_url: string,          // https://<host>/invite/<code>     — share this
//     invite_expires_at: string,   // ISO timestamp; 7 days from now
//   }
//
// Spam vector is acknowledged — anonymous endpoint with no rate-limit
// in this MVP. The team accepted that explicitly while shipping. Add
// rate-limits or proof-of-work later if it becomes a problem.

import { randomBytes } from "node:crypto";
import type { EntityId } from "@doco/shared";
import { validateDocoSlug } from "@doco/shared";
import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";
import { addAgentPrincipal, createDocoInHost, reindex } from "~/lib/redeem.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let body: { slug?: string; description?: string } = {};
  try {
    body = (await request.json()) as { slug?: string; description?: string };
  } catch {
    // Empty body is fine — all fields are optional.
  }

  const isoNow = new Date().toISOString();
  const agentUsername = `agent-${randomBytes(6).toString("hex")}`;
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  let agentId: EntityId<"principal">;
  try {
    agentId = await addAgentPrincipal(rootDir(), {
      username: agentUsername,
      display_name: `Anonymous agent ${agentUsername}`,
      owner_id: null,
      agent_metadata: {
        provider: userAgent,
        model: userAgent,
        capabilities: [],
        created_at: isoNow,
      },
    });
  } catch (e) {
    return Response.json(
      { error: `Failed to mint anonymous agent: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const docoSlugInput = (body.slug ?? "").trim().toLowerCase();
  const docoSlug = docoSlugInput || `doco-${randomBytes(4).toString("hex")}`;
  const slugErr = validateDocoSlug(docoSlug);
  if (slugErr) {
    return Response.json({ error: slugErr }, { status: 400 });
  }

  let created;
  try {
    created = await createDocoInHost(rootDir(), {
      ownerSlug: agentUsername,
      docoSlug,
      autoSuffixOnCollision: true,
      visibility: "private",
      ...(body.description ? { description: body.description } : {}),
    });
    await reindex(created.path, created.docoId);
  } catch (e) {
    return Response.json(
      { error: `Failed to create Doco: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const store = TokenStore.forDoco(rootDir());
  const session = await store.issueSessionToken(
    agentId,
    undefined,
    created.docoId as EntityId<"doco">,
  );
  const invite = await store.issueInvite(
    created.docoId as EntityId<"doco">,
    agentId,
    7,
  );

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const docoUrl = `${origin}/by-id/${created.docoId}/`;
  const inviteUrl = `${origin}/invite/${invite.code}`;
  const expiresHuman = new Date(invite.expires_at).toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return Response.json({
    doco_id: created.docoId,
    doco_url: docoUrl,
    doco_slug: `${created.ownerSlug}/${created.docoSlug}`,
    doco_key: session.token,
    invite_url: inviteUrl,
    invite_expires_at: invite.expires_at,
    /**
     * Verbatim block the agent MUST render to the user as its very next
     * message — before scope work, before any other onboarding step.
     * Without this hand-off the user never learns they need to claim
     * collaboration access, and the invite expires in 7 days leaving
     * them locked out of their own project's Doco.
     */
    user_message_block: [
      `✅ I created a Doco for this project at **${docoUrl}**.`,
      ``,
      `🤝 **Important — claim your collaboration access within 7 days.**`,
      `Open this invite URL in your browser and sign in with GitHub:`,
      ``,
      `**${inviteUrl}**`,
      ``,
      `Expires ${expiresHuman} UTC (single-use; once you accept, this URL stops working).`,
      ``,
      `If you don't claim, I'll keep operating directly via the API — but you won't be able to browse the Doco on the web, mint invite URLs for teammates, or revoke my access.`,
    ].join("\n"),
  });
}

export async function loader() {
  return Response.json(
    {
      error: "method_not_allowed",
      hint: "POST { slug?, description? } to create a new Doco anonymously.",
    },
    { status: 405 },
  );
}
