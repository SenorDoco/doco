// API keys are OAuth refresh tokens minted on behalf of a signed-in
// human user. Two paths into this table:
//
//   1. OAuth flow. An MCP runtime registers a client, drives
//      /oauth/authorize or /device, the user names the token + approves
//      scopes, and a refresh token gets minted for the approving user.
//
//   2. Personal API keys (new). The user clicks "Generate API key" on
//      /tokens, picks a scope, and we register a synthetic OAuth
//      client + mint tokens directly — no PKCE, no redirect dance.
//
// Both shapes land in the same `oauth_refresh_tokens` row format, so
// this file lists / revokes them uniformly. OAuth rows use `token_name`
// for the human-visible credential label.
//
// Distinguishing personal from OAuth-flow tokens: personal-API-key clients carry
// the OOB redirect URI sentinel (`urn:ietf:wg:oauth:2.0:oob`) — that
// value never appears for an OAuth-flow client because the OAuth
// /authorize endpoint rejects it as a callback target.

import { type DocoRole, getWorkspaceRole, listWorkspacesForUser, withClient } from "@doco/db";
import { WRITE_ALL, normalizeWriteTypes } from "@doco/shared";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { qualifiedDocoLabel } from "~/lib/doco-labels";
import { assertSingleWorkspaceGrant, issueTokens, registerClient } from "~/lib/oauth-server.server";
import type { CurrentPrincipal } from "~/lib/session.server";
import { ALL_ROLES, rankOf } from "~/lib/user-invite";

const PERSONAL_API_KEY_REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

export interface ScopeOption {
  level: "workspace" | "doco";
  id: string;
  label: string;
  myRole: DocoRole;
  /** Owning workspace id (doco options only) — groups docos under their workspace. */
  workspaceId?: string;
}

export interface ApiKeyScopeGrant {
  level: "workspace" | "doco";
  target_id: string;
  target_label: string;
  target_link: string;
  role: DocoRole;
  writeTypes: string[];
}

export interface ApiKeyRow {
  client_id: string;
  client_name: string;
  source: "personal" | "oauth";
  granted_at: string;
  last_used_at: string | null;
  expires_at: string;
  scope_grants: ApiKeyScopeGrant[];
  /** 'actor' = an "All your workspaces" token (breadth is live membership, no explicit grants). */
  grant_type: "regular" | "actor";
  /** Role ceiling for an actor token (reader|writer); null = owner = full live role. */
  actor_role: DocoRole | null;
}

export interface ApiKeysPageData {
  me: CurrentPrincipal;
  keys: ApiKeyRow[];
  scopeOptions: ScopeOption[];
  /** Origin (protocol://host) used to build OAuth invite URLs. */
  host: string;
  justMinted: MintedApiKey | null;
}

export interface MintedApiKey {
  access_token: string;
  refresh_token: string;
  client_id: string;
  expires_in: number;
  client_name: string;
  scope_grants: ApiKeyScopeGrant[];
}

export async function listApiKeysForUser(principalId: string): Promise<ApiKeyRow[]> {
  const result = await withClient((c) =>
    c.query<{
      client_id: string;
      client_name: string | null;
      token_name: string | null;
      user_id: string;
      redirect_uris: string[];
      granted_doco_ids: string[] | null;
      granted_doco_roles: Record<string, string> | null;
      granted_doco_write_types: Record<string, string[]> | null;
      granted_workspace_ids: string[] | null;
      granted_workspace_roles: Record<string, string> | null;
      granted_workspace_write_types: Record<string, string[]> | null;
      grant_type: string | null;
      actor_role: string | null;
      created_at: Date | string;
      expires_at: Date | string;
      last_seen_at: Date | string | null;
    }>(
      `SELECT DISTINCT ON (rt.client_id)
              rt.client_id,
              c.client_name,
              rt.token_name,
              rt.user_id,
              c.redirect_uris,
              rt.granted_doco_ids,
              rt.granted_doco_roles,
              rt.granted_doco_write_types,
              rt.granted_workspace_ids,
              rt.granted_workspace_roles,
              rt.granted_workspace_write_types,
              rt.grant_type,
              rt.actor_role,
              rt.created_at,
              rt.expires_at,
              (SELECT MAX(at.created_at)
                 FROM oauth_access_tokens at
                WHERE at.client_id = rt.client_id
                  AND at.user_id = rt.user_id) AS last_seen_at
         FROM oauth_refresh_tokens rt
         JOIN oauth_clients c ON c.client_id = rt.client_id
        WHERE rt.user_id = $1
          AND rt.revoked = false
          AND rt.expires_at > now()
        ORDER BY rt.client_id, rt.created_at DESC`,
      [principalId],
    ),
  );

  const allDocoIds = new Set<string>();
  const allWorkspaceIds = new Set<string>();
  for (const row of result.rows) {
    for (const id of row.granted_doco_ids ?? []) allDocoIds.add(id);
    for (const id of row.granted_workspace_ids ?? []) allWorkspaceIds.add(id);
  }
  const docoLabels = await loadDocoLabels([...allDocoIds]);
  const workspaceHandles = await loadWorkspaceHandles([...allWorkspaceIds]);

  const rows = result.rows.map((row): ApiKeyRow => {
    const grants: ApiKeyScopeGrant[] = [];
    for (const workspaceId of row.granted_workspace_ids ?? []) {
      const handle = workspaceHandles.get(workspaceId);
      if (!handle) continue;
      const role = (row.granted_workspace_roles?.[workspaceId] ?? "reader") as DocoRole;
      const writeTypes = normalizeWriteTypes(row.granted_workspace_write_types?.[workspaceId]);
      grants.push({
        level: "workspace",
        target_id: workspaceId,
        target_label: handle,
        target_link: `/workspaces/${handle}`,
        role,
        writeTypes,
      });
    }
    for (const docoId of row.granted_doco_ids ?? []) {
      const label = docoLabels.get(docoId);
      if (!label) continue;
      const role = (row.granted_doco_roles?.[docoId] ?? "reader") as DocoRole;
      const writeTypes = normalizeWriteTypes(row.granted_doco_write_types?.[docoId]);
      grants.push({
        level: "doco",
        target_id: docoId,
        target_label: label.label,
        target_link: `/${label.handle}`,
        role,
        writeTypes,
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

    const clientName = row.client_name ?? row.client_id;
    return {
      client_id: row.client_id,
      client_name: isPersonal ? clientName : row.token_name?.trim() || clientName,
      source: isPersonal ? "personal" : "oauth",
      granted_at: grantedAt,
      last_used_at: lastSeenAt,
      expires_at: expiresAt,
      scope_grants: grants,
      grant_type: row.grant_type === "actor" ? "actor" : "regular",
      actor_role: (row.actor_role as DocoRole | null) ?? null,
    };
  });

  rows.sort((a, b) => {
    if (a.last_used_at && b.last_used_at) {
      return b.last_used_at.localeCompare(a.last_used_at);
    }
    if (a.last_used_at) return -1;
    if (b.last_used_at) return 1;
    return b.granted_at.localeCompare(a.granted_at);
  });

  return rows;
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
         LEFT JOIN workspaces o ON o.id = d.owner_id
         LEFT JOIN users c ON c.id = d.owner_id
        WHERE d.id = ANY($1) AND d.deleted_at IS NULL`,
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

async function loadWorkspaceHandles(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await withClient((c) =>
    c.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM workspaces WHERE id = ANY($1)",
      [ids],
    ),
  );
  for (const r of rows.rows) out.set(String(r.id), String(r.handle));
  return out;
}

export async function loadScopeOptions(principalId: string): Promise<ScopeOption[]> {
  const workspaces = await listWorkspacesForUser(principalId);
  const options: ScopeOption[] = [];
  for (const o of workspaces) {
    const role = (await getWorkspaceRole(o.id, principalId)) ?? "reader";
    options.push({ level: "workspace", id: o.id, label: o.handle, myRole: role });
  }

  const docoIds = await listAccessibleDocoIdsForPrincipal(principalId);
  for (const docoId of docoIds) {
    const docoRow = await withClient((c) =>
      c.query<{ handle: string; owner_id: string; owner_slug: string }>(
        `SELECT d.handle, d.owner_id, COALESCE(o.handle, c.github_login, '') AS owner_slug
           FROM docos d
           LEFT JOIN workspaces o ON o.id = d.owner_id
           LEFT JOIN users c ON c.id = d.owner_id
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
      workspaceId: String(row.owner_id),
    });
  }
  // Sort by label across workspaces + docos so the picker reads alphabetically.
  options.sort((a, b) => a.label.localeCompare(b.label));
  return options;
}

export interface MintApiKeyInput {
  me: CurrentPrincipal;
  label: string;
  grants: ApiKeyGrantInput[];
  /**
   * 'actor' mints a user-level credential reaching ALL the minter's workspaces
   * (one per session, scoped at refresh time) — no explicit grants. 'regular'
   * (default) is the existing per-workspace/doco scoped token.
   */
  grantType?: "regular" | "actor";
  /**
   * Role CEILING for an actor token (reader|writer|owner). At refresh the access
   * token gets min(your live role, this) per workspace. null/undefined = owner =
   * full live role. Ignored unless grantType is 'actor'.
   */
  actorRole?: DocoRole | null;
}

export interface ApiKeyGrantInput {
  level: "account" | "workspace" | "doco";
  /** Empty for account-level grants (the minter's account is the scope). */
  target_id: string;
  role: DocoRole;
  /** Per-type write set (decision_per_type_write_grants); "*" = all. */
  write_types?: string[];
}

export async function mintApiKey(input: MintApiKeyInput): Promise<MintedApiKey> {
  const trimmedLabel = input.label.trim();
  if (!trimmedLabel) {
    throw new Error("Label is required.");
  }

  // Actor token: a user-level credential with NO explicit grants. Its breadth
  // is the minter's LIVE workspace membership, resolved (and down-scoped to one
  // workspace) when refreshTokens exchanges it for an access token. So skip the
  // per-target grant machinery entirely — there are no targets to validate.
  if (input.grantType === "actor") {
    const client = await registerClient({
      client_name: trimmedLabel,
      redirect_uris: [PERSONAL_API_KEY_REDIRECT],
    });
    const tokens = await issueTokens({
      client_id: client.client_id,
      user_id: input.me.id,
      token_name: trimmedLabel,
      granted_doco_ids: [],
      granted_workspace_ids: [],
      scope: null,
      grant_type: "actor",
      actor_role: input.actorRole ?? null,
    });
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      expires_in: tokens.expires_in,
      client_name: trimmedLabel,
      scope_grants: [],
    };
  }

  if (input.grants.length === 0) {
    throw new Error("Pick at least one workspace or doco to scope this key to.");
  }

  // An account-level grant on a token expands, AT MINT TIME, to a grant on
  // every workspace the minter owns. Unlike the live user→user account grant, a
  // token is a snapshot credential: workspaces created later are NOT auto-added
  // (mint a fresh token to widen). Non-owned workspaces are skipped — you can
  // only delegate from workspaces you own.
  const expandedGrants = await expandAccountGrants(input.me, input.grants);
  if (expandedGrants.length === 0) {
    throw new Error("You don't own any workspace to scope an account token to.");
  }
  const grants = expandedGrants;

  await assertApiKeyGrantsAllowed(input.me, grants);

  const client = await registerClient({
    client_name: trimmedLabel,
    redirect_uris: [PERSONAL_API_KEY_REDIRECT],
  });

  const {
    granted_doco_ids,
    granted_doco_roles,
    granted_doco_write_types,
    granted_workspace_ids,
    granted_workspace_roles,
    granted_workspace_write_types,
    scopeGrants,
  } = await serializeApiKeyGrants(grants);

  const tokens = await issueTokens({
    client_id: client.client_id,
    user_id: input.me.id,
    token_name: trimmedLabel,
    granted_doco_ids,
    granted_doco_roles,
    granted_doco_write_types,
    granted_workspace_ids,
    granted_workspace_roles,
    granted_workspace_write_types,
    scope: null,
  });

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    client_id: client.client_id,
    expires_in: tokens.expires_in,
    client_name: trimmedLabel,
    scope_grants: scopeGrants,
  };
}

async function expandAccountGrants(
  me: CurrentPrincipal,
  inputGrants: ApiKeyGrantInput[],
): Promise<ApiKeyGrantInput[]> {
  const expandedGrants: ApiKeyGrantInput[] = [];
  for (const grant of inputGrants) {
    if (grant.level === "account") {
      const workspaces = await listWorkspacesForUser(me.id);
      for (const workspace of workspaces) {
        const myRole = await getWorkspaceRole(workspace.id, me.id);
        if (myRole === "owner") {
          expandedGrants.push({
            level: "workspace",
            target_id: workspace.id,
            role: grant.role,
            write_types: grant.write_types,
          });
        }
      }
    } else {
      expandedGrants.push(grant);
    }
  }
  return expandedGrants;
}

async function assertApiKeyGrantsAllowed(
  me: CurrentPrincipal,
  grants: ApiKeyGrantInput[],
): Promise<void> {
  for (const grant of grants) {
    if (!ALL_ROLES.includes(grant.role)) {
      throw new Error(`Invalid role: ${grant.role}`);
    }
    const myRole =
      grant.level === "workspace"
        ? await getWorkspaceRole(grant.target_id, me.id)
        : await getDocoLevelRoleForGrant(grant.target_id, me.id);
    if (!myRole) {
      throw new Error(`You don't have a role on this ${grant.level}.`);
    }
    if (rankOf(grant.role) > rankOf(myRole)) {
      throw new Error(
        `Cannot grant '${grant.role}' on a ${grant.level} where you only hold '${myRole}'.`,
      );
    }
  }
}

async function serializeApiKeyGrants(grants: ApiKeyGrantInput[]): Promise<{
  granted_doco_ids: string[];
  granted_doco_roles: Record<string, string>;
  granted_doco_write_types: Record<string, string[]>;
  granted_workspace_ids: string[];
  granted_workspace_roles: Record<string, string>;
  granted_workspace_write_types: Record<string, string[]>;
  scopeGrants: ApiKeyScopeGrant[];
}> {
  const granted_doco_ids: string[] = [];
  const granted_doco_roles: Record<string, string> = {};
  const granted_doco_write_types: Record<string, string[]> = {};
  const granted_workspace_ids: string[] = [];
  const granted_workspace_roles: Record<string, string> = {};
  const granted_workspace_write_types: Record<string, string[]> = {};
  const scopeGrants: ApiKeyScopeGrant[] = [];

  const docoLabels = await loadDocoLabels(
    grants.filter((g) => g.level === "doco").map((g) => g.target_id),
  );
  const workspaceHandles = await loadWorkspaceHandles(
    grants.filter((g) => g.level === "workspace").map((g) => g.target_id),
  );

  // Effective write-type scope for a grant: owner writes everything
  // (no per-type entry needed); an explicit set is normalized; absent →
  // wildcard for a writer, nothing for a reader.
  const writeTypesFor = (grant: { role: DocoRole; write_types?: string[] }): string[] | null => {
    if (grant.role === "owner") return null;
    if (grant.write_types !== undefined) {
      const norm = normalizeWriteTypes(grant.write_types);
      return norm.length > 0 ? norm : null;
    }
    return grant.role === "writer" ? ["*"] : null;
  };

  for (const grant of grants) {
    const wt = writeTypesFor(grant);
    if (grant.level === "workspace") {
      granted_workspace_ids.push(grant.target_id);
      granted_workspace_roles[grant.target_id] = grant.role;
      if (wt) granted_workspace_write_types[grant.target_id] = wt;
      const handle = workspaceHandles.get(grant.target_id) ?? grant.target_id;
      scopeGrants.push({
        level: "workspace",
        target_id: grant.target_id,
        target_label: handle,
        target_link: `/workspaces/${handle}`,
        role: grant.role,
        writeTypes: wt ?? [],
      });
    } else {
      granted_doco_ids.push(grant.target_id);
      granted_doco_roles[grant.target_id] = grant.role;
      if (wt) granted_doco_write_types[grant.target_id] = wt;
      const label = docoLabels.get(grant.target_id);
      const handle = label?.handle ?? grant.target_id;
      scopeGrants.push({
        level: "doco",
        target_id: grant.target_id,
        target_label: label?.label ?? grant.target_id,
        target_link: `/${handle}`,
        role: grant.role,
        writeTypes: wt ?? [],
      });
    }
  }

  return {
    granted_doco_ids,
    granted_doco_roles,
    granted_doco_write_types,
    granted_workspace_ids,
    granted_workspace_roles,
    granted_workspace_write_types,
    scopeGrants,
  };
}

export async function addGrantsToApiKey(input: {
  me: CurrentPrincipal;
  client_id: string;
  grants: ApiKeyGrantInput[];
}): Promise<ApiKeyScopeGrant[]> {
  if (!input.client_id.trim()) throw new Error("Missing client_id.");
  if (input.grants.length === 0) throw new Error("Pick at least one thing to grant access to.");

  const expandedGrants = await expandAccountGrants(input.me, input.grants);
  if (expandedGrants.length === 0) {
    throw new Error("You don't own any workspace to scope an account token to.");
  }
  await assertApiKeyGrantsAllowed(input.me, expandedGrants);

  const incoming = await serializeApiKeyGrants(expandedGrants);

  return await withClient(async (c) => {
    const existing = await c.query<{
      client_id: string;
      user_id: string;
      granted_doco_ids: string[] | null;
      granted_doco_roles: Record<string, string> | null;
      granted_doco_write_types: Record<string, string[]> | null;
      granted_workspace_ids: string[] | null;
      granted_workspace_roles: Record<string, string> | null;
      granted_workspace_write_types: Record<string, string[]> | null;
    }>(
      `SELECT rt.client_id, rt.user_id,
              rt.granted_doco_ids, rt.granted_doco_roles, rt.granted_doco_write_types,
              rt.granted_workspace_ids, rt.granted_workspace_roles, rt.granted_workspace_write_types
         FROM oauth_refresh_tokens rt
        WHERE rt.client_id = $1
          AND rt.user_id = $2
          AND rt.revoked = false
          AND rt.expires_at > now()
        ORDER BY rt.created_at DESC
        LIMIT 1`,
      [input.client_id, input.me.id],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Token not found or already revoked.");

    const mergedDoco = mergeTokenScope(
      row.granted_doco_ids ?? [],
      row.granted_doco_roles ?? {},
      row.granted_doco_write_types ?? {},
      incoming.granted_doco_ids,
      incoming.granted_doco_roles,
      incoming.granted_doco_write_types,
    );
    const mergedWorkspace = mergeTokenScope(
      row.granted_workspace_ids ?? [],
      row.granted_workspace_roles ?? {},
      row.granted_workspace_write_types ?? {},
      incoming.granted_workspace_ids,
      incoming.granted_workspace_roles,
      incoming.granted_workspace_write_types,
    );

    // The merged result — not just the incoming delta — must still fit inside a
    // single workspace. Widening a token toward a second workspace is rejected
    // here before any row is written.
    await assertSingleWorkspaceGrant({
      granted_doco_ids: mergedDoco.ids,
      granted_workspace_ids: mergedWorkspace.ids,
    });

    const values = [
      input.client_id,
      mergedDoco.ids,
      JSON.stringify(mergedDoco.roles),
      JSON.stringify(mergedDoco.writeTypes),
      mergedWorkspace.ids,
      JSON.stringify(mergedWorkspace.roles),
      JSON.stringify(mergedWorkspace.writeTypes),
      input.me.id,
    ];
    await c.query(
      `UPDATE oauth_refresh_tokens rt
          SET granted_doco_ids = $2,
              granted_doco_roles = $3::jsonb,
              granted_doco_write_types = $4::jsonb,
              granted_workspace_ids = $5,
              granted_workspace_roles = $6::jsonb,
              granted_workspace_write_types = $7::jsonb
        WHERE rt.client_id = $1
          AND rt.user_id = $8
          AND rt.revoked = false
          AND rt.expires_at > now()`,
      values,
    );
    await c.query(
      `UPDATE oauth_access_tokens at
          SET granted_doco_ids = $2,
              granted_doco_roles = $3::jsonb,
              granted_doco_write_types = $4::jsonb,
              granted_workspace_ids = $5,
              granted_workspace_roles = $6::jsonb,
              granted_workspace_write_types = $7::jsonb
        WHERE at.client_id = $1
          AND at.user_id = $8
          AND at.revoked = false
          AND at.expires_at > now()`,
      values,
    );

    return incoming.scopeGrants;
  });
}

/**
 * Convert an existing scoped token into an "All your workspaces" (actor) token
 * at `actorRole` (null = owner = full live role). Unlike addGrantsToApiKey this
 * is a REPLACEMENT, not a widening: the refresh token's explicit grants are
 * dropped and grant_type flips to 'actor', so its breadth becomes the user's
 * live membership (one workspace per session, capped at the ceiling) resolved at
 * refresh time. The refresh token itself stays (non-rotating — DOCO_REFRESH is
 * unchanged); the live scoped access tokens are revoked so the next refresh
 * re-mints an actor-scoped one.
 */
export async function convertApiKeyToActor(input: {
  me: CurrentPrincipal;
  client_id: string;
  actorRole: DocoRole | null;
}): Promise<void> {
  if (!input.client_id.trim()) throw new Error("Missing client_id.");
  await withClient(async (c) => {
    const existing = await c.query<{ client_id: string }>(
      `SELECT client_id
         FROM oauth_refresh_tokens
        WHERE client_id = $1
          AND user_id = $2
          AND revoked = false
          AND expires_at > now()
        LIMIT 1`,
      [input.client_id, input.me.id],
    );
    if (!existing.rows[0]) throw new Error("Token not found or already revoked.");

    await c.query(
      `UPDATE oauth_refresh_tokens
          SET grant_type = 'actor',
              actor_role = $3,
              granted_doco_ids = ARRAY[]::text[],
              granted_doco_roles = '{}'::jsonb,
              granted_doco_write_types = '{}'::jsonb,
              granted_workspace_ids = ARRAY[]::text[],
              granted_workspace_roles = '{}'::jsonb,
              granted_workspace_write_types = '{}'::jsonb
        WHERE client_id = $1
          AND user_id = $2
          AND revoked = false
          AND expires_at > now()`,
      [input.client_id, input.me.id, input.actorRole],
    );
    // Cut off the old single-workspace access tokens immediately; the client's
    // next refresh (with a `resource`) re-mints under the actor breadth.
    await c.query(
      `UPDATE oauth_access_tokens
          SET revoked = true
        WHERE client_id = $1
          AND user_id = $2
          AND revoked = false`,
      [input.client_id, input.me.id],
    );
  });
}

function mergeTokenScope(
  baseIds: string[],
  baseRoles: Record<string, string>,
  baseWriteTypes: Record<string, string[]>,
  incomingIds: string[],
  incomingRoles: Record<string, string>,
  incomingWriteTypes: Record<string, string[]>,
): { ids: string[]; roles: Record<string, string>; writeTypes: Record<string, string[]> } {
  const ids = [...new Set([...baseIds, ...incomingIds])].sort();
  const incomingSet = new Set(incomingIds);
  const baseSet = new Set(baseIds);
  const roles: Record<string, string> = {};
  const writeTypes: Record<string, string[]> = {};
  for (const id of ids) {
    const baseRole = baseSet.has(id) ? ((baseRoles[id] ?? "reader") as DocoRole) : null;
    const incomingRole = incomingSet.has(id) ? ((incomingRoles[id] ?? "reader") as DocoRole) : null;
    const role = incomingRole ?? baseRole ?? "reader";
    roles[id] = role;
    if (role !== "owner") {
      const stored = incomingSet.has(id)
        ? effectiveStoredWriteTypes(incomingRole, incomingWriteTypes[id])
        : effectiveStoredWriteTypes(baseRole, baseWriteTypes[id]);
      if (stored.length > 0) writeTypes[id] = stored;
    }
  }
  return { ids, roles, writeTypes };
}

function effectiveStoredWriteTypes(role: DocoRole | null, writeTypes: string[] | undefined) {
  if (!role || role === "owner") return [];
  const normalized = normalizeWriteTypes(writeTypes);
  if (normalized.length > 0) return normalized;
  return role === "writer" ? [WRITE_ALL] : [];
}

async function getDocoLevelRoleForGrant(
  docoId: string,
  principalId: string,
): Promise<DocoRole | null> {
  const row = await withClient((c) =>
    c.query<{ owner_id: string }>(
      "SELECT owner_id FROM docos WHERE id = $1 AND deleted_at IS NULL",
      [docoId],
    ),
  );
  const ownerId = row.rows[0]?.owner_id;
  if (!ownerId) return null;
  return getDocoLevelRole({ ownerId: String(ownerId), docoId }, principalId);
}

export async function revokeApiKey(args: {
  user_id: string;
  client_id: string;
}): Promise<boolean> {
  return withClient(async (c) => {
    const accessResult = await c.query(
      `UPDATE oauth_access_tokens
          SET revoked = true
        WHERE oauth_access_tokens.client_id = $1
          AND oauth_access_tokens.user_id = $2
          AND oauth_access_tokens.revoked = false`,
      [args.client_id, args.user_id],
    );
    const refreshResult = await c.query(
      `UPDATE oauth_refresh_tokens
          SET revoked = true
        WHERE oauth_refresh_tokens.client_id = $1
          AND oauth_refresh_tokens.user_id = $2
          AND oauth_refresh_tokens.revoked = false`,
      [args.client_id, args.user_id],
    );
    return (accessResult.rowCount ?? 0) + (refreshResult.rowCount ?? 0) > 0;
  });
}
