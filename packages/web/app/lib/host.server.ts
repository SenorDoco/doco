// Host-level reads from Postgres via @doco/db.

import {
  listAllDocos as _dbListAllDocos,
  getHostConfig,
  listUsers as listUserRows,
  listWorkspaces as listWorkspaceRows,
  listWorkspacesForUser,
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

export interface HostWorkspace {
  id: string;
  handle: string;
  display_name: string;
  description?: string;
  member_count: number;
}

export interface HostDoco {
  /** Public globally-unique URL identifier. */
  handle: string;
  /** Owner's user username or workspace handle, derived via
   *  JOIN in mapDocoRow. Useful for "owned by alice" labels. */
  ownerUsername: string;
  ownerKind: "principal" | "workspace";
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
  const rows = await listUserRows();
  return rows.map((r) => {
    const out: HostUser = {
      id: r.id,
      username: r.github_login ?? r.id,
    };
    if (r.email) out.email = r.email;
    return out;
  });
}

export async function listWorkspaces(): Promise<HostWorkspace[]> {
  const rows = await listWorkspaceRows();
  return rows.map((r) => {
    const fm = r.data;
    const out: HostWorkspace = {
      id: r.id,
      handle: r.handle,
      display_name: (fm.display_name as string) ?? r.name,
      member_count: r.member_count,
    };
    if (typeof fm.description === "string") out.description = fm.description;
    return out;
  });
}

export async function listMyWorkspaces(userId: string): Promise<HostWorkspace[]> {
  const rows = await listWorkspacesForUser(userId);
  return rows.map((r) => {
    const fm = r.data;
    const out: HostWorkspace = {
      id: r.id,
      handle: r.handle,
      display_name: (fm.display_name as string) ?? r.name,
      member_count: r.member_count,
    };
    if (typeof fm.description === "string") out.description = fm.description;
    return out;
  });
}

export async function listWorkspacesOwnedOrAdminedBy(userId: string): Promise<HostWorkspace[]> {
  const rows = await listWorkspacesForUser(userId, ["owner"]);
  return rows.map((r) => {
    const fm = r.data;
    const out: HostWorkspace = {
      id: r.id,
      handle: r.handle,
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
    const ownerKind: "principal" | "workspace" = r.owner_id.startsWith("workspace_")
      ? "workspace"
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
