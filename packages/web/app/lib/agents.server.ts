// Agent-creation logic shared between the web app and the API surface.
// Used by /agents/new (owner creates an agent + DOCO_ACCESS directly) and
// /cli/authorize (Vercel-style browser-authorize handoff).

import { upsertEntity } from "@doco/db";
import { type EntityId, generateUlid, makeEntityId, nowIso } from "@doco/shared";

export interface AddAgentPrincipalOpts {
  username: string;
  /**
   * Human or agent that owns this agent. Nullable for anonymous-create
   * agents (the `POST /api/v1/docos` path) — those have no human at the
   * root of their invitation chain. ADR-035's "chains root at a person"
   * invariant is explicitly relaxed for that flow (see the
   * "agents-can-create-Docos-on-their-own" Decision in the metaDoco).
   */
  owner_id: EntityId<"principal"> | null;
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
    doco_id: `doco_${generateUlid()}` as EntityId<"doco">,
    entity_type: "principal",
    summary: `Agent ${opts.username}.`,
    type: "agent",
    username: opts.username,
    owner_id: opts.owner_id,
    agent_metadata: opts.agent_metadata,
    created_at: created,
    // owner created this agent — null when owner_id is null (anonymous create)
    created_by: opts.owner_id,
    lifecycle: "active",
  };
  // Upsert into Postgres so access-credential resolution (which reads
  // `principals` via `getPrincipalById`) finds the row on the next request.
  await upsertEntity({
    id,
    doco_id: yamlObj.doco_id,
    entity_type: "principal",
    raw_yaml: JSON.stringify(yamlObj),
    summary: yamlObj.summary,
    lifecycle: yamlObj.lifecycle,
    created_at: yamlObj.created_at,
    created_by: yamlObj.created_by,
    updated_at: yamlObj.created_at,
    updated_by: yamlObj.created_by,
  });
  return id;
}
