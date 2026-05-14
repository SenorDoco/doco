// Shared invitation-redemption + agent-creation logic.
//
// Used by both the API server (POST /api/v1/invitations/redeem) and the web
// route GET/POST /invite/:token. Extracting the logic here means the web can
// redeem without depending on the API server being up — they read the same
// .doco/tokens.json + principals/ tree.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type EntityId,
  generateUlid,
  makeEntityId,
  nowIso,
} from "@doco/shared";
import { TokenStore } from "./auth.js";

export interface PrincipalSummary {
  id: string;
  username: string;
  display_name: string;
  type: "person" | "agent";
}

export function findPrincipalById(root: string, id: string): PrincipalSummary | null {
  const dir = join(root, "principals");
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("principal_") || !name.endsWith(".yaml")) continue;
    const e = parseYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
    if (e.id === id) {
      return {
        id: e.id as string,
        username: e.username as string,
        display_name: (e.display_name as string) ?? (e.username as string),
        type: e.type as "person" | "agent",
      };
    }
  }
  return null;
}

export interface AddAgentPrincipalOpts {
  username: string;
  display_name: string;
  owner_id: EntityId<"principal">;
  agent_metadata: {
    provider: string;
    model: string;
    capabilities: string[];
    created_at: string;
  };
}

/**
 * Wraps host.addPrincipal but passes type='agent' + owner_id + agent_metadata.
 * The host package's existing addPrincipal helper hardcodes type='person',
 * so we hand-roll the agent path here. Once @doco/host gains a dedicated
 * addAgent function this can collapse.
 */
export async function addAgentPrincipal(
  root: string,
  opts: AddAgentPrincipalOpts,
): Promise<EntityId<"principal">> {
  const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
  const created = nowIso();
  const yamlObj = {
    id,
    doco_id: ("doco_" + generateUlid()) as EntityId<"doco">,
    node_type: "principal",
    summary: `Agent ${opts.username}.`,
    type: "agent",
    username: opts.username,
    display_name: opts.display_name,
    owner_id: opts.owner_id,
    agent_metadata: opts.agent_metadata,
    created_at: created,
    created_by: opts.owner_id, // owner created this agent
    lifecycle: "active",
    scopes: [],
  };
  const path = `${root}/principals/${id}.yaml`;
  await writeFile(path, stringifyYaml(yamlObj), "utf8");
  return id;
}

export interface RedemptionBody {
  display_name?: string;
  model?: string;
  provider?: string;
  capabilities?: string[];
}

export interface RedemptionResult {
  session_token: string;
  principal: {
    id: EntityId<"principal">;
    username: string;
    display_name: string;
    type: "agent";
    owner_id: EntityId<"principal">;
  };
}

export type RedemptionError =
  | { kind: "invalid_or_expired_invitation" }
  | { kind: "inviter_no_longer_exists" }
  | { kind: "create_principal_failed"; detail: string };

/**
 * Redeem an invitation token: marks the invitation used, creates a Principal{type:agent}
 * owned by the inviter, and issues a long-lived session token.
 *
 * Idempotent only in the single-use sense: a given invitation token can be redeemed
 * at most once. Subsequent calls return `invalid_or_expired_invitation`.
 */
export async function redeemInvitation(
  root: string,
  inviteToken: string,
  body: RedemptionBody,
): Promise<RedemptionResult | { error: RedemptionError }> {
  const tokenStore = TokenStore.forDoco(root);
  const inv = await tokenStore.resolveInvitation(inviteToken);
  if (!inv) return { error: { kind: "invalid_or_expired_invitation" } };

  const inviter = findPrincipalById(root, inv.inviter_id);
  if (!inviter) return { error: { kind: "inviter_no_longer_exists" } };

  // Username convention per ADR-036: `{inviter_username}/{ISO_timestamp}`.
  const isoNow = new Date().toISOString();
  const username = `${inviter.username}/${isoNow}`;
  const displayName = body.display_name ?? `agent ${username}`;

  let principalId: EntityId<"principal">;
  try {
    principalId = await addAgentPrincipal(root, {
      username,
      display_name: displayName,
      owner_id: inv.inviter_id,
      agent_metadata: {
        provider: body.provider ?? "unknown",
        model: body.model ?? "unknown",
        capabilities: body.capabilities ?? [],
        created_at: isoNow,
      },
    });
  } catch (e) {
    return { error: { kind: "create_principal_failed", detail: (e as Error).message } };
  }

  await tokenStore.markInvitationUsed(inviteToken);
  const session = await tokenStore.issueSessionToken(principalId, inv.inviter_id);

  return {
    session_token: session.token,
    principal: {
      id: principalId,
      username,
      display_name: displayName,
      type: "agent",
      owner_id: inv.inviter_id,
    },
  };
}
