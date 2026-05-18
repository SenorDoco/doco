// POST /api/v1/docos.json — anonymous Doco creation.
//
// Any user (agent or human) can call this with no prior auth. The
// server preallocates the Doco id, mints a setup-agent Principal as
// the owner-of-record, creates the new Doco under it, issues an access
// credential bound to that Doco, and mints an initial 7-day Invite
// so the creator has a sharable URL on the same response.
//
// Input (application/json, all optional):
//   {
//     requested_id?: string,   // preferred human-readable id; auto-suffixed
//                              // (-2, -3, ...) on global collision.
//     description?: string,
//   }
//
// Output shape is shared with the invite-redemption endpoint via
// `~/lib/agent-bootstrap-response.server` (see `BootstrapResponse`).
// Create-side responses always carry the invite handoff fields:
//   {
//     doco_id: string,             // ULID — stable internal id (FK target)
//     doco_handle: string,         // public, human-readable URL id
//     doco_url: string,            // https://<host>/<doco_handle>/
//     doco_access: string,         // for .env as DOCO_ACCESS=<hex>
//     invite_url: string,          // https://<host>/invite/<code>
//     invite_expires_at: string,
//     next_steps_for_agent: string[],
//     user_message_block: string,  // verbatim claim-within-7-days block
//   }
//
// Spam vector is acknowledged — anonymous endpoint with no rate-limit
// in this MVP. The team accepted that explicitly while shipping. Add
// rate-limits or proof-of-work later if it becomes a problem.

import { randomBytes } from "node:crypto";
import type { EntityId } from "@doco/shared";
import { generateUlid, makeEntityId, validateDocoSlug } from "@doco/shared";
import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";
import { addAgentPrincipal, createDocoInHost, reindex } from "~/lib/redeem.server";
import { buildAgentBootstrapResponse } from "~/lib/agent-bootstrap-response.server";
import { loadBootstrapContext } from "~/lib/bootstrap-context.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let body: { requested_id?: string; description?: string } = {};
  try {
    body = (await request.json()) as {
      requested_id?: string;
      description?: string;
    };
  } catch {
    // Empty body is fine — all fields are optional.
  }

  const isoNow = new Date().toISOString();
  const docoId = makeEntityId("doco", generateUlid()) as EntityId<"doco">;
  const agentUsername = `setup-agent-${docoId.toLowerCase()}`;
  const userAgent = request.headers.get("user-agent") ?? "unknown";
  let agentId: EntityId<"principal">;
  try {
    agentId = await addAgentPrincipal(rootDir(), {
      username: agentUsername,
      display_name: "Setup agent",
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

  const requestedInput = (body.requested_id ?? "").trim().toLowerCase();
  const docoSlug = requestedInput || `doco-${randomBytes(4).toString("hex")}`;
  const slugErr = validateDocoSlug(docoSlug);
  if (slugErr) {
    return Response.json({ error: slugErr }, { status: 400 });
  }

  let created;
  try {
    created = await createDocoInHost(rootDir(), {
      ownerSlug: agentUsername,
      docoSlug,
      docoId,
      requestedId: docoSlug,
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
  const inviteUrl = `${origin}/invite/${invite.code}`;

  // Bundle the per-Doco bootstrap context so the agent doesn't need a
  // follow-on /api/v1/agent-bootstrap fetch right after this call —
  // see the agent-bootstrap-response.server file header for why that
  // pattern trips credential-exfil heuristics.
  const context = await loadBootstrapContext({
    docoDir: created.path,
    docoId: created.docoId,
    handle: created.handle,
    baseUrl: origin,
  });

  // Response shape (doco coordinates + recipe + canonical_instructions +
  // user_message_block) is built by the same helper the invite-redemption
  // endpoint uses, so future tweaks to either flow propagate to the other.
  return Response.json(
    buildAgentBootstrapResponse({
      flow: "create",
      origin,
      doco: { id: created.docoId, handle: created.handle },
      accessToken: session.token,
      invite: { url: inviteUrl, expires_at: invite.expires_at },
      context,
    }),
  );
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
