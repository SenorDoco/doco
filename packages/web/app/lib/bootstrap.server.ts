// Server-only helper. Lazily creates the `host-bootstrap` placeholder Principal
// used as the temporary owner of unclaimed Docos created by agents through the
// onboarding wizard. Per ADR-073.
//
// The placeholder is type:person (so the person-ancestry rule is mechanically
// satisfied) but flagged via username so we can recognize it. It is NOT a real
// account — it can't sign in (the sign-in picker filters it out) and it can't
// own anything other than placeholder Docos.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type EntityId,
  generateUlid,
  makeEntityId,
  nowIso,
} from "@doco/shared";

export const HOST_BOOTSTRAP_USERNAME = "host-bootstrap";

export interface HostBootstrapPrincipal {
  id: EntityId<"principal">;
  username: string;
  display_name: string;
}

/** Returns the bootstrap principal id, creating it on first call. */
export function getOrCreateHostBootstrap(root: string): HostBootstrapPrincipal {
  const dir = join(root, "principals");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("principal_") || !name.endsWith(".yaml")) continue;
      const e = parseYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      if (e.username === HOST_BOOTSTRAP_USERNAME) {
        return {
          id: e.id as EntityId<"principal">,
          username: e.username as string,
          display_name: (e.display_name as string) ?? HOST_BOOTSTRAP_USERNAME,
        };
      }
    }
  }
  const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
  const created = nowIso();
  const yaml = {
    id,
    doco_id: ("doco_" + generateUlid()) as EntityId<"doco">,
    node_type: "principal",
    summary:
      "Placeholder owner for Docos created by agents through the onboarding wizard before an owner has claimed ownership.",
    type: "person", // technically — keeps the person-ancestry rule satisfied
    username: HOST_BOOTSTRAP_USERNAME,
    display_name: "Unclaimed bootstrap",
    github_identity: { github_login: HOST_BOOTSTRAP_USERNAME },
    created_at: created,
    created_by: id,
    lifecycle: "active",
    scopes: [],
    bootstrap_placeholder: true, // future: lints/UI can recognize this
  };
  writeFileSync(join(dir, `${id}.yaml`), stringifyYaml(yaml), "utf8");
  return { id, username: HOST_BOOTSTRAP_USERNAME, display_name: "Unclaimed bootstrap" };
}

export function isHostBootstrapPrincipalId(root: string, principalId: string): boolean {
  try {
    const bs = getOrCreateHostBootstrap(root);
    return bs.id === principalId;
  } catch {
    return false;
  }
}
