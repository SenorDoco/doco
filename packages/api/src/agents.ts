// Agent-creation logic shared between the web app and the API surface.
// Used by /agents/new (owner creates an agent + DOCO_TOKEN directly) and
// /cli/authorize (Vercel-style browser-authorize handoff).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type EntityId,
  generateUlid,
  makeEntityId,
  nowIso,
} from "@doco/shared";
import { upsertEntity } from "@doco/db";

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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringifyYaml(yamlObj), "utf8");
  // Also upsert into Postgres so session-token resolution (which reads
  // `principals` via `getPrincipalById`) finds the row on the next request.
  // Filesystem-only writes leave the agent unauthenticated until a host
  // reindex catches up; for the CLI authorize flow the agent uses the
  // token immediately, so we sync inline here.
  await upsertEntity({
    id,
    doco_id: yamlObj.doco_id,
    node_type: "principal",
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

