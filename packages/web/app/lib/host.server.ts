// Host-level reads — Phase 3 Postgres-only
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
//
// All filesystem walks of `<root>/host.yaml`, `<root>/principals/`,
// `<root>/organizations/`, and `<root>/docos/<owner>/<slug>/doco.yaml`
// have been replaced with Postgres queries via @doco/db.

import {
  listAllDocos as _dbListAllDocos,
  getHostConfig,
  listCollaborators,
  listOrganizations,
  listOrganizationsForCollaborator,
} from "@doco/db";

export interface HostConfig {
  id: string;
  name: string;
  visibility: "private" | "public";
}

export interface HostUser {
  id: string;
  username: string;
  email?: string;
}

export interface HostOrg {
  id: string;
  slug: string;
  display_name: string;
  description?: string;
  member_count: number;
}

export interface HostDoco {
  /** Public globally-unique URL identifier. */
  handle: string;
  /** Owner's username (Principal.username) or org slug, derived via
   *  JOIN in mapDocoRow. Useful for "owned by alice" labels. */
  ownerUsername: string;
  ownerKind: "principal" | "organization";
  ownerId: string;
  /** Internal ULID — FK target for every entity table. */
  docoId: string;
  hasIndex: boolean;
  visibility: "private" | "public";
}

export async function loadHostConfig(): Promise<HostConfig> {
  const row = await getHostConfig();
  if (!row) {
    throw new Error("No host config in Postgres. Run host ingestion first.");
  }
  return { id: row.id, name: row.name, visibility: row.visibility };
}

export async function listUsers(): Promise<HostUser[]> {
  // Post-rename: OAuth identities (humans + agent runtimes) live in
  // the `collaborators` table, not `principals`. Principals are
  // role-personas referenced by actor_id, not users-of-the-system.
  const rows = await listCollaborators({ kind: "person" });
  return rows.map((r) => {
    const out: HostUser = {
      id: r.id,
      username: r.github_login ?? r.id,
    };
    if (r.email) out.email = r.email;
    return out;
  });
}

export async function listOrgs(): Promise<HostOrg[]> {
  const rows = await listOrganizations();
  return rows.map((r) => {
    const fm = r.data;
    const out: HostOrg = {
      id: r.id,
      slug: r.slug,
      display_name: (fm.display_name as string) ?? r.name,
      member_count: r.member_count,
    };
    if (typeof fm.description === "string") out.description = fm.description;
    return out;
  });
}

export async function listMyOrgs(principalId: string): Promise<HostOrg[]> {
  const rows = await listOrganizationsForCollaborator(principalId);
  return rows.map((r) => {
    const fm = r.data;
    const out: HostOrg = {
      id: r.id,
      slug: r.slug,
      display_name: (fm.display_name as string) ?? r.name,
      member_count: r.member_count,
    };
    if (typeof fm.description === "string") out.description = fm.description;
    return out;
  });
}

export async function listOrgsOwnedOrAdminedBy(principalId: string): Promise<HostOrg[]> {
  const rows = await listOrganizationsForCollaborator(principalId, ["owner"]);
  return rows.map((r) => {
    const fm = r.data;
    const out: HostOrg = {
      id: r.id,
      slug: r.slug,
      display_name: (fm.display_name as string) ?? r.name,
      member_count: r.member_count,
    };
    if (typeof fm.description === "string") out.description = fm.description;
    return out;
  });
}

export async function listAllDocos(): Promise<HostDoco[]> {
  const rows = await _dbListAllDocos();
  return rows.map((r) => {
    const ownerKind: "principal" | "organization" = r.owner_id.startsWith("organization_")
      ? "organization"
      : "principal";
    return {
      handle: r.handle,
      ownerUsername: r.owner_slug,
      ownerKind,
      ownerId: r.owner_id,
      docoId: r.id,
      hasIndex: true,
      visibility: r.visibility,
    };
  });
}
