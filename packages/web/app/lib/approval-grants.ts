// Single source of truth for the token-approval grant matrix shared by
// the Device-Flow (`/device`) and OAuth (`/oauth/authorize`) approve
// screens. Both render the SAME GrantPicker over the SAME data: every
// org and Doco the approver can grant. Grants are owner-tier — the
// approval backend (oauth-approval-grants.server.ts `assertOwns*`)
// rejects anything less on submit, so the picker only offers what the
// approver owns.
//
// A client may name a Doco it wants (`target_doco_handle`). That request
// does NOT change the matrix — the approver always sees the full set of
// scopes (account / org / doco / types) they're entitled to, exactly
// like the collaborators and API-token pages. The target only drives a
// notice when the requested handle isn't one the approver owns.

import type { DocoRole } from "@doco/db";

export interface ApprovalDocoOption {
  id: string;
  handle: string;
  my_role: DocoRole;
  /** Owning org id for org-owned Docos, or null when owned directly. */
  org_id: string | null;
  /**
   * Owning org handle, so the picker can label its org bucket. The
   * builder always sets it; optional so callers/tests may omit it.
   */
  org_label?: string | null;
}

export interface ApprovalOrgOption {
  id: string;
  handle: string;
  display_name: string;
  my_role: DocoRole;
}

export interface ApprovalGrantView {
  docos: ApprovalDocoOption[];
  orgs: ApprovalOrgOption[];
  targetedMessage: string | null;
}

/**
 * Resolve what the approve screen shows for a requested target. The
 * matrix (docos + orgs) is returned UNCHANGED — the picker is identical
 * at every entry point; a requested target never strips scopes or
 * narrows the list. The target only controls the "you don't own that
 * Doco" notice.
 */
export function resolveApprovalGrantView(
  docos: ApprovalDocoOption[],
  orgs: ApprovalOrgOption[],
  targetDocoHandle: string | null | undefined,
): ApprovalGrantView {
  const targetedMessage =
    targetDocoHandle && !docos.some((d) => d.handle === targetDocoHandle)
      ? `The token requested access to "${targetDocoHandle}" but you don't own that Doco — pick from the Docos you do own below, or ask the client to target a different one.`
      : null;
  return { docos, orgs, targetedMessage };
}
