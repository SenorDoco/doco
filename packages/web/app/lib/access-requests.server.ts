// The request/grant loop. Someone (person or agent) who can't fully use a
// Doco asks its owners for a role; an owner approves — which writes a
// doco_users grant — or denies. Because connector tokens defer to the matrix
// (see oauth-approval-grants), an approved grant works on the requester's
// NEXT call with no re-authorization. This module is the authz + orchestration
// layer over the @doco/db access_requests functions.

import {
  type AccessRequestRow,
  type DocoRole,
  createAccessRequest,
  decideAccessRequest,
  getAccessRequest,
  getDocoById,
  getDocoByIdOrHandle,
  getUserById,
  listPendingAccessRequestCountsByDoco,
  listPendingAccessRequestsForDocos,
  roleAtLeast,
  upsertDocoUser,
} from "@doco/db";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { loadApprovalGrantOptions } from "~/lib/oauth-approval-grants.server";

export type RequestAccessResult =
  | { ok: true; alreadyHad: false; request: AccessRequestRow; docoHandle: string }
  | { ok: true; alreadyHad: true; role: DocoRole; docoHandle: string }
  | { ok: false; error: string };

/**
 * A person/agent asks a Doco's owners for `requestedRole`. If they already
 * hold that role (or higher), it's a no-op success — nothing to request.
 */
export async function requestDocoAccess(opts: {
  docoHandleOrId: string;
  requesterId: string;
  requestedRole: DocoRole;
  reason?: string | null;
}): Promise<RequestAccessResult> {
  const doco = await getDocoByIdOrHandle(opts.docoHandleOrId);
  if (!doco) return { ok: false, error: `No Doco "${opts.docoHandleOrId}".` };

  const current = await getDocoLevelRole(
    { ownerId: doco.owner_id, docoId: doco.id },
    opts.requesterId,
  );
  if (current && roleAtLeast(current, opts.requestedRole)) {
    return { ok: true, alreadyHad: true, role: current, docoHandle: doco.handle };
  }

  const request = await createAccessRequest({
    doco_id: doco.id,
    requester_id: opts.requesterId,
    requested_role: opts.requestedRole,
    reason: opts.reason ?? null,
  });
  return { ok: true, alreadyHad: false, request, docoHandle: doco.handle };
}

export type DecideResult =
  | { ok: true; request: AccessRequestRow }
  | { ok: false; error: string; status: number };

// Shared gate: the decider must be an owner of the request's Doco.
async function gateDecision(
  id: string,
  approverId: string,
): Promise<{ req: AccessRequestRow } | { error: string; status: number }> {
  const req = await getAccessRequest(id);
  if (!req) return { error: "Request not found.", status: 404 };
  const doco = await getDocoById(req.doco_id);
  if (!doco) return { error: "Doco not found.", status: 404 };
  const role = await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, approverId);
  if (role !== "owner") {
    return { error: "Only an owner can decide access requests.", status: 403 };
  }
  return { req };
}

/** Approve: flip the request to approved AND write the doco_users grant. */
export async function approveAccessRequest(opts: {
  id: string;
  approverId: string;
}): Promise<DecideResult> {
  const gated = await gateDecision(opts.id, opts.approverId);
  if ("error" in gated) return { ok: false, error: gated.error, status: gated.status };

  const decided = await decideAccessRequest({
    id: opts.id,
    status: "approved",
    decided_by: opts.approverId,
  });
  if (!decided) return { ok: false, error: "Request was already decided.", status: 409 };

  await upsertDocoUser({
    doco_id: decided.doco_id,
    user_id: decided.requester_id,
    role: decided.requested_role,
  });
  return { ok: true, request: decided };
}

/** Deny: flip the request to denied; no grant is written. */
export async function denyAccessRequest(opts: {
  id: string;
  approverId: string;
}): Promise<DecideResult> {
  const gated = await gateDecision(opts.id, opts.approverId);
  if ("error" in gated) return { ok: false, error: gated.error, status: gated.status };

  const decided = await decideAccessRequest({
    id: opts.id,
    status: "denied",
    decided_by: opts.approverId,
  });
  if (!decided) return { ok: false, error: "Request was already decided.", status: 409 };
  return { ok: true, request: decided };
}

export interface OwnerInboxItem {
  id: string;
  doco_id: string;
  doco_handle: string;
  requester_id: string;
  requester_login: string;
  requested_role: DocoRole;
  reason: string | null;
  created_at: string;
}

/** Pending requests across every Doco the viewer owns — the owner's inbox. */
export async function listAccessRequestsForOwner(ownerId: string): Promise<OwnerInboxItem[]> {
  const { docos } = await loadApprovalGrantOptions(ownerId); // owner-tier only
  if (docos.length === 0) return [];
  const handleById = new Map(docos.map((d) => [d.id, d.handle]));
  const pending = await listPendingAccessRequestsForDocos(docos.map((d) => d.id));

  const items: OwnerInboxItem[] = [];
  for (const r of pending) {
    const requester = await getUserById(r.requester_id);
    items.push({
      id: r.id,
      doco_id: r.doco_id,
      doco_handle: handleById.get(r.doco_id) ?? r.doco_id,
      requester_id: r.requester_id,
      requester_login: requester?.github_login ?? r.requester_id,
      requested_role: r.requested_role,
      reason: r.reason,
      created_at: r.created_at,
    });
  }
  return items;
}

/**
 * How many pending requests sit in this owner's inbox — the count behind the
 * header badge. Equals `listAccessRequestsForOwner(ownerId).length` by
 * construction (same "accessible ∩ owner" universe the inbox page uses), but
 * computed cheaply enough to run on every page load: when nothing is pending
 * anywhere it's a single grouped query and an early return, and ownership is
 * resolved only for the handful of Docos that actually have live requests.
 */
export async function countPendingAccessRequestsForOwner(ownerId: string): Promise<number> {
  const counts = await listPendingAccessRequestCountsByDoco();
  if (counts.length === 0) return 0;

  // Mirror the inbox page's universe: a Doco the viewer can reach AND owns.
  // Anchoring on the accessible set keeps the badge in lockstep with the page
  // even for owner roles (e.g. account grants) the page itself wouldn't list.
  const accessible = new Set(await listAccessibleDocoIdsForPrincipal(ownerId));
  let total = 0;
  for (const { doco_id, owner_id, n } of counts) {
    if (!accessible.has(doco_id)) continue;
    const role = await getDocoLevelRole({ ownerId: owner_id, docoId: doco_id }, ownerId);
    if (role === "owner") total += n;
  }
  return total;
}
