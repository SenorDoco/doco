import { type DocoRole, getOrgRole, listOrganizationsForUser } from "@doco/db";
import { WRITE_ALL, normalizeWriteTypes } from "@doco/shared";
import { getDocoById } from "~/lib/db.server";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";

const DOCO_ROLES = ["reader", "writer", "owner"] as const;

export interface OAuthApprovalGrantSets {
  granted_doco_ids: string[];
  granted_doco_roles: Record<string, string>;
  granted_doco_write_types: Record<string, string[]>;
  granted_org_ids: string[];
  granted_org_roles: Record<string, string>;
  granted_org_write_types: Record<string, string[]>;
}

interface ParsedApprovalGrant {
  level: "account" | "org" | "doco";
  targetId: string;
  role: DocoRole;
  writeTypes: string[];
}

export async function readOAuthApprovalGrants(
  form: FormData,
  principalId: string,
): Promise<OAuthApprovalGrantSets> {
  const rawGrants = String(form.get("grants") ?? "").trim();
  if (rawGrants) {
    return serializeApprovalGrants(parseGrantPayload(rawGrants), principalId);
  }
  return serializeLegacyApprovalFields(form, principalId);
}

function parseGrantPayload(rawGrants: string): ParsedApprovalGrant[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawGrants);
  } catch {
    throw approvalError("Malformed grants list.", 400);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw approvalError("at least one Doco or organization must be selected", 400);
  }

  return parsed.map((raw): ParsedApprovalGrant => {
    if (!raw || typeof raw !== "object") {
      throw approvalError("Malformed grant entry.", 400);
    }
    const grant = raw as {
      level?: unknown;
      targetId?: unknown;
      target_id?: unknown;
      role?: unknown;
      writeTypes?: unknown;
      write_types?: unknown;
    };
    const level =
      grant.level === "account" || grant.level === "org" || grant.level === "doco"
        ? grant.level
        : null;
    const role = readRole(grant.role);
    const targetId = String(grant.targetId ?? grant.target_id ?? "").trim();
    if (!level || (level !== "account" && !targetId)) {
      throw approvalError("Grant missing a target.", 400);
    }
    const rawWriteTypes = grant.writeTypes ?? grant.write_types;
    const hasWriteTypes = Array.isArray(rawWriteTypes);
    const writeTypes =
      role === "owner"
        ? []
        : hasWriteTypes
          ? normalizeWriteTypes(rawWriteTypes.map(String))
          : role === "writer"
            ? [WRITE_ALL]
            : [];
    return { level, targetId, role, writeTypes };
  });
}

async function serializeApprovalGrants(
  input: ParsedApprovalGrant[],
  principalId: string,
): Promise<OAuthApprovalGrantSets> {
  const grants = emptyGrantSets();
  const allowedDocos = new Set(await listAccessibleDocoIdsForPrincipal(principalId));

  for (const grant of await expandAccountGrants(input, principalId)) {
    if (grant.level === "org") {
      await assertOwnsOrg(principalId, grant.targetId);
      addGrant(grants, "org", grant.targetId, grant.role, grant.writeTypes);
      continue;
    }
    if (grant.level === "doco") {
      await assertOwnsDoco(principalId, grant.targetId, allowedDocos);
      addGrant(grants, "doco", grant.targetId, grant.role, grant.writeTypes);
    }
  }

  if (grants.granted_doco_ids.length === 0 && grants.granted_org_ids.length === 0) {
    throw approvalError("at least one Doco or organization must be selected", 400);
  }

  grants.granted_doco_ids.sort();
  grants.granted_org_ids.sort();
  return grants;
}

async function expandAccountGrants(
  grants: ParsedApprovalGrant[],
  principalId: string,
): Promise<ParsedApprovalGrant[]> {
  const out: ParsedApprovalGrant[] = [];
  for (const grant of grants) {
    if (grant.level !== "account") {
      out.push(grant);
      continue;
    }
    const orgs = await listOrganizationsForUser(principalId);
    let added = 0;
    for (const org of orgs) {
      if ((await getOrgRole(org.id, principalId)) !== "owner") continue;
      added += 1;
      out.push({
        level: "org",
        targetId: org.id,
        role: grant.role,
        writeTypes: grant.writeTypes,
      });
    }
    if (added === 0) {
      throw approvalError("You don't own any organization to scope an account token to.", 400);
    }
  }
  return out;
}

async function serializeLegacyApprovalFields(
  form: FormData,
  principalId: string,
): Promise<OAuthApprovalGrantSets> {
  const grants = emptyGrantSets();
  const selected = form.getAll("doco_id").map((v) => String(v));
  const selectedOrgs = form.getAll("org_id").map((v) => String(v));
  if (selected.length === 0 && selectedOrgs.length === 0) {
    throw approvalError("at least one Doco or organization must be selected", 400);
  }
  const allowedDocos = new Set(await listAccessibleDocoIdsForPrincipal(principalId));

  for (const id of selected) {
    await assertOwnsDoco(principalId, id, allowedDocos);
    const role = readRole(form.get(`role_${id}`) ?? "owner");
    addGrant(grants, "doco", id, role, defaultWriteTypesForRole(role));
  }
  for (const orgId of selectedOrgs) {
    await assertOwnsOrg(principalId, orgId);
    const role = readRole(form.get(`role_org_${orgId}`) ?? "owner");
    addGrant(grants, "org", orgId, role, defaultWriteTypesForRole(role));
  }
  return grants;
}

async function assertOwnsDoco(
  principalId: string,
  docoId: string,
  allowedDocos: Set<string>,
): Promise<void> {
  if (!allowedDocos.has(docoId)) throw approvalError(`not authorized for ${docoId}`, 403);
  const doco = await getDocoById(docoId);
  if (!doco) throw approvalError(`unknown doco: ${docoId}`, 400);
  const myRole = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, principalId);
  if (myRole !== "owner") {
    throw approvalError(
      `Only owners can grant access; you hold '${myRole ?? "no role"}' on ${doco.handle}.`,
      403,
    );
  }
}

async function assertOwnsOrg(principalId: string, orgId: string): Promise<void> {
  if (!orgId.startsWith("organization_")) {
    throw approvalError(`invalid org id: ${orgId}`, 400);
  }
  const myOrgRole = await getOrgRole(orgId, principalId);
  if (myOrgRole !== "owner") {
    throw approvalError(
      `Only org owners can grant access; you hold '${myOrgRole ?? "no role"}' on ${orgId}.`,
      403,
    );
  }
}

function addGrant(
  grants: OAuthApprovalGrantSets,
  level: "org" | "doco",
  id: string,
  role: DocoRole,
  writeTypes: string[],
) {
  const ids = level === "org" ? grants.granted_org_ids : grants.granted_doco_ids;
  const roles = level === "org" ? grants.granted_org_roles : grants.granted_doco_roles;
  const writeTypeMap =
    level === "org" ? grants.granted_org_write_types : grants.granted_doco_write_types;

  if (!ids.includes(id)) ids.push(id);
  roles[id] = strongerRole((roles[id] as DocoRole | undefined) ?? role, role);

  const merged = normalizeWriteTypes([...(writeTypeMap[id] ?? []), ...writeTypes]);
  if (roles[id] === "owner" || merged.length === 0) {
    delete writeTypeMap[id];
  } else {
    writeTypeMap[id] = merged;
  }
}

function emptyGrantSets(): OAuthApprovalGrantSets {
  return {
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_org_ids: [],
    granted_org_roles: {},
    granted_org_write_types: {},
  };
}

function readRole(value: unknown): DocoRole {
  const raw = String(value ?? "").toLowerCase();
  if ((DOCO_ROLES as readonly string[]).includes(raw)) return raw as DocoRole;
  throw approvalError("Invalid grant role.", 400);
}

function defaultWriteTypesForRole(role: DocoRole): string[] {
  return role === "writer" ? [WRITE_ALL] : [];
}

function strongerRole(a: DocoRole, b: DocoRole): DocoRole {
  return rank(b) > rank(a) ? b : a;
}

function rank(role: DocoRole): number {
  return role === "owner" ? 2 : role === "writer" ? 1 : 0;
}

function approvalError(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
