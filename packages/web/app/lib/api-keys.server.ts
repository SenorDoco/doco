// API keys are OAuth refresh tokens minted on behalf of a signed-in
// user. Two paths into this table:
//
//   1. Agent OAuth flow. An MCP runtime registers a client, drives
//      /oauth/authorize or /device, the user names the agent + approves
//      scopes, and a refresh token gets minted for that agent collaborator.
//
//   2. Personal API keys (new). The user clicks "Generate API key" on
//      /api-keys, picks a scope, and we register a synthetic OAuth
//      client + mint tokens directly — no PKCE, no redirect dance.
//
// Both shapes land in the same `oauth_refresh_tokens` row format, so
// this file lists / revokes them uniformly. Agent OAuth rows are shown
// to the approving owner through collaborators.owner_id.
//
// Distinguishing personal from agent: personal-API-key clients carry
// the OOB redirect URI sentinel (`urn:ietf:wg:oauth:2.0:oob`) — that
// value never appears for an OAuth-flow client because the OAuth
// /authorize endpoint rejects it as a callback target.

import { type DocoRole, getOrgRole, listOrganizationsForCollaborator, withClient } from "@doco/db";
import { ALL_ROLES, rankOf } from "~/lib/collaborator-invite";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { qualifiedDocoLabel } from "~/lib/doco-labels";
import { issueTokens, registerClient } from "~/lib/oauth-server.server";
import type { CurrentPrincipal } from "~/lib/session.server";

const PERSONAL_API_KEY_REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

export interface ScopeOption {
  level: "org" | "doco";
  id: string;
  label: string;
  myRole: DocoRole;
}

export interface ApiKeyScopeGrant {
  level: "org" | "doco";
  target_id: string;
  target_label: string;
  target_link: string;
  role: DocoRole;
}

export interface ApiKeyRow {
  client_id: string;
  client_name: string;
  source: "personal" | "agent";
  granted_at: string;
  last_used_at: string | null;
  expires_at: string;
  scope_grants: ApiKeyScopeGrant[];
}

export interface ApiKeysPageData {
  me: CurrentPrincipal;
  keys: ApiKeyRow[];
  scopeOptions: ScopeOption[];
  /** Origin (protocol://host) used to build agent OAuth invite URLs. */
  host: string;
  justMinted: MintedApiKey | null;
}

export interface MintedApiKey {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  client_name: string;
  scope_grants: ApiKeyScopeGrant[];
}

export async function listApiKeysForCollaborator(principalId: string): Promise<ApiKeyRow[]> {
  const result = await withClient((c) =>
    c.query<{
      client_id: string;
      client_name: string | null;
      collaborator_id: string;
      collaborator_kind: "person" | "agent";
      collaborator_login: string | null;
      collaborator_data: Record<string, unknown> | null;
      redirect_uris: string[];
      granted_doco_ids: string[] | null;
      granted_doco_roles: Record<string, string> | null;
      granted_org_ids: string[] | null;
      granted_org_roles: Record<string, string> | null;
      created_at: Date | string;
      expires_at: Date | string;
      last_seen_at: Date | string | null;
    }>(
      `SELECT DISTINCT ON (rt.client_id)
              rt.client_id,
              c.client_name,
              rt.collaborator_id,
              subject.kind AS collaborator_kind,
              subject.github_login AS collaborator_login,
              subject.data AS collaborator_data,
              c.redirect_uris,
              rt.granted_doco_ids,
              rt.granted_doco_roles,
              rt.granted_org_ids,
              rt.granted_org_roles,
              rt.created_at,
              rt.expires_at,
              (SELECT MAX(at.created_at)
                 FROM oauth_access_tokens at
                WHERE at.client_id = rt.client_id
                  AND at.collaborator_id = rt.collaborator_id) AS last_seen_at
         FROM oauth_refresh_tokens rt
         JOIN oauth_clients c ON c.client_id = rt.client_id
         JOIN collaborators subject ON subject.id = rt.collaborator_id
        WHERE (rt.collaborator_id = $1 OR subject.owner_id = $1)
          AND rt.revoked = false
          AND rt.expires_at > now()
        ORDER BY rt.client_id, rt.created_at DESC`,
      [principalId],
    ),
  );

  const allDocoIds = new Set<string>();
  const allOrgIds = new Set<string>();
  for (const row of result.rows) {
    for (const id of row.granted_doco_ids ?? []) allDocoIds.add(id);
    for (const id of row.granted_org_ids ?? []) allOrgIds.add(id);
  }
  const docoLabels = await loadDocoLabels([...allDocoIds]);
  const orgHandles = await loadOrgHandles([...allOrgIds]);

  return result.rows.map((row) => {
    const grants: ApiKeyScopeGrant[] = [];
    for (const orgId of row.granted_org_ids ?? []) {
      const handle = orgHandles.get(orgId);
      if (!handle) continue;
      const role = (row.granted_org_roles?.[orgId] ?? "reader") as DocoRole;
      grants.push({
        level: "org",
        target_id: orgId,
        target_label: handle,
        target_link: `/orgs/${handle}`,
        role,
      });
    }
    for (const docoId of row.granted_doco_ids ?? []) {
      const label = docoLabels.get(docoId);
      if (!label) continue;
      const role = (row.granted_doco_roles?.[docoId] ?? "reader") as DocoRole;
      grants.push({
        level: "doco",
        target_id: docoId,
        target_label: label.label,
        target_link: `/${label.handle}`,
        role,
      });
    }
    grants.sort((a, b) => a.target_label.localeCompare(b.target_label));

    const isPersonal = (row.redirect_uris ?? []).includes(PERSONAL_API_KEY_REDIRECT);
    const grantedAt =
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
    const expiresAt =
      row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at);
    const lastSeenAt = row.last_seen_at
      ? row.last_seen_at instanceof Date
        ? row.last_seen_at.toISOString()
        : String(row.last_seen_at)
      : null;

    const subjectName = collaboratorDisplayName({
      id: row.collaborator_id,
      github_login: row.collaborator_login,
      data: row.collaborator_data,
    });
    const clientName = row.client_name ?? row.client_id;
    return {
      client_id: row.client_id,
      client_name: !isPersonal && row.collaborator_kind === "agent" ? subjectName : clientName,
      source: isPersonal ? "personal" : "agent",
      granted_at: grantedAt,
      last_used_at: lastSeenAt,
      expires_at: expiresAt,
      scope_grants: grants,
    };
  });
}

function collaboratorDisplayName(row: {
  id: string;
  github_login: string | null;
  data: Record<string, unknown> | null;
}): string {
  const data = row.data && typeof row.data === "object" ? row.data : {};
  const named = data.name ?? data.display_name;
  if (typeof named === "string" && named.trim()) return named.trim();
  return row.github_login ?? row.id;
}

async function loadDocoLabels(
  ids: string[],
): Promise<Map<string, { handle: string; label: string }>> {
  const out = new Map<string, { handle: string; label: string }>();
  if (ids.length === 0) return out;
  const rows = await withClient((c) =>
    c.query<{ id: string; handle: string; owner_slug: string }>(
      `SELECT d.id, d.handle, COALESCE(o.handle, c.github_login, '') AS owner_slug
         FROM docos d
         LEFT JOIN organizations o ON o.id = d.owner_id
         LEFT JOIN collaborators c ON c.id = d.owner_id
        WHERE d.id = ANY($1)`,
      [ids],
    ),
  );
  for (const r of rows.rows) {
    const handle = String(r.handle);
    out.set(String(r.id), {
      handle,
      label: qualifiedDocoLabel({ ownerSlug: String(r.owner_slug ?? ""), handle }),
    });
  }
  return out;
}

async function loadOrgHandles(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await withClient((c) =>
    c.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM organizations WHERE id = ANY($1)",
      [ids],
    ),
  );
  for (const r of rows.rows) out.set(String(r.id), String(r.handle));
  return out;
}

export async function loadScopeOptions(principalId: string): Promise<ScopeOption[]> {
  const orgs = await listOrganizationsForCollaborator(principalId);
  const options: ScopeOption[] = [];
  for (const o of orgs) {
    const role = (await getOrgRole(o.id, principalId)) ?? "reader";
    options.push({ level: "org", id: o.id, label: o.handle, myRole: role });
  }

  const docoIds = await listAccessibleDocoIdsForPrincipal(principalId);
  for (const docoId of docoIds) {
    const docoRow = await withClient((c) =>
      c.query<{ handle: string; owner_id: string; owner_slug: string }>(
        `SELECT d.handle, d.owner_id, COALESCE(o.handle, c.github_login, '') AS owner_slug
           FROM docos d
           LEFT JOIN organizations o ON o.id = d.owner_id
           LEFT JOIN collaborators c ON c.id = d.owner_id
          WHERE d.id = $1`,
        [docoId],
      ),
    );
    const row = docoRow.rows[0];
    if (!row) continue;
    const role = await getDocoLevelRole({ ownerId: String(row.owner_id), docoId }, principalId);
    if (!role) continue;
    options.push({
      level: "doco",
      id: docoId,
      label: qualifiedDocoLabel({
        ownerSlug: String(row.owner_slug ?? ""),
        handle: String(row.handle),
      }),
      myRole: role,
    });
  }
  // Sort by label across orgs + docos so the picker reads alphabetically.
  options.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}

export interface MintApiKeyInput {
  me: CurrentPrincipal;
  label: string;
  grants: Array<{
    level: "org" | "doco";
    target_id: string;
    role: DocoRole;
  }>;
}

export async function mintApiKey(input: MintApiKeyInput): Promise<MintedApiKey> {
  const trimmedLabel = input.label.trim();
  if (!trimmedLabel) {
    throw new Error("Label is required.");
  }
  if (input.grants.length === 0) {
    throw new Error("Pick at least one org or doco to scope this key to.");
  }
  for (const grant of input.grants) {
    if (!ALL_ROLES.includes(grant.role)) {
      throw new Error(`Invalid role: ${grant.role}`);
    }
    const myRole =
      grant.level === "org"
        ? await getOrgRole(grant.target_id, input.me.id)
        : await getDocoLevelRoleForGrant(grant.target_id, input.me.id);
    if (!myRole) {
      throw new Error(`You don't have a role on this ${grant.level}.`);
    }
    if (rankOf(grant.role) > rankOf(myRole)) {
      throw new Error(
        `Cannot grant '${grant.role}' on a ${grant.level} where you only hold '${myRole}'.`,
      );
    }
  }

  const client = await registerClient({
    client_name: trimmedLabel,
    redirect_uris: [PERSONAL_API_KEY_REDIRECT],
  });

  const granted_doco_ids: string[] = [];
  const granted_doco_roles: Record<string, string> = {};
  const granted_org_ids: string[] = [];
  const granted_org_roles: Record<string, string> = {};
  const scopeGrants: ApiKeyScopeGrant[] = [];

  const docoLabels = await loadDocoLabels(
    input.grants.filter((g) => g.level === "doco").map((g) => g.target_id),
  );
  const orgHandles = await loadOrgHandles(
    input.grants.filter((g) => g.level === "org").map((g) => g.target_id),
  );

  for (const grant of input.grants) {
    if (grant.level === "org") {
      granted_org_ids.push(grant.target_id);
      granted_org_roles[grant.target_id] = grant.role;
      const handle = orgHandles.get(grant.target_id) ?? grant.target_id;
      scopeGrants.push({
        level: "org",
        target_id: grant.target_id,
        target_label: handle,
        target_link: `/orgs/${handle}`,
        role: grant.role,
      });
    } else {
      granted_doco_ids.push(grant.target_id);
      granted_doco_roles[grant.target_id] = grant.role;
      const label = docoLabels.get(grant.target_id);
      const handle = label?.handle ?? grant.target_id;
      scopeGrants.push({
        level: "doco",
        target_id: grant.target_id,
        target_label: label?.label ?? grant.target_id,
        target_link: `/${handle}`,
        role: grant.role,
      });
    }
  }

  const tokens = await issueTokens({
    client_id: client.client_id,
    collaborator_id: input.me.id,
    granted_doco_ids,
    granted_doco_roles,
    granted_org_ids,
    granted_org_roles,
    scope: null,
  });

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    client_name: trimmedLabel,
    scope_grants: scopeGrants,
  };
}

async function getDocoLevelRoleForGrant(
  docoId: string,
  principalId: string,
): Promise<DocoRole | null> {
  const row = await withClient((c) =>
    c.query<{ owner_id: string }>("SELECT owner_id FROM docos WHERE id = $1", [docoId]),
  );
  const ownerId = row.rows[0]?.owner_id;
  if (!ownerId) return null;
  return getDocoLevelRole({ ownerId: String(ownerId), docoId }, principalId);
}

export async function revokeApiKey(args: {
  collaborator_id: string;
  client_id: string;
}): Promise<boolean> {
  return withClient(async (c) => {
    const accessResult = await c.query(
      `UPDATE oauth_access_tokens
          SET revoked = true
         FROM collaborators subject
        WHERE oauth_access_tokens.collaborator_id = subject.id
          AND oauth_access_tokens.client_id = $1
          AND (oauth_access_tokens.collaborator_id = $2 OR subject.owner_id = $2)
          AND oauth_access_tokens.revoked = false`,
      [args.client_id, args.collaborator_id],
    );
    const refreshResult = await c.query(
      `UPDATE oauth_refresh_tokens
          SET revoked = true
         FROM collaborators subject
        WHERE oauth_refresh_tokens.collaborator_id = subject.id
          AND oauth_refresh_tokens.client_id = $1
          AND (oauth_refresh_tokens.collaborator_id = $2 OR subject.owner_id = $2)
          AND oauth_refresh_tokens.revoked = false`,
      [args.client_id, args.collaborator_id],
    );
    return (accessResult.rowCount ?? 0) + (refreshResult.rowCount ?? 0) > 0;
  });
}
