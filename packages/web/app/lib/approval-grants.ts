// Single source of truth for the token-approval grant matrix shared by
// the Device-Flow (`/device`) and OAuth (`/oauth/authorize`) approve
// screens. Both render the SAME GrantPicker over the SAME data: every
// workspace and Doco the approver can grant. Grants are owner-tier — the
// approval backend (oauth-approval-grants.server.ts `assertOwns*`)
// rejects anything less on submit, so the picker only offers what the
// approver owns.
//
// A client may name a Doco it wants (`target_doco_handle`). When the
// approver owns it (or no target was given), the matrix is the full set
// of scopes (account / workspace / doco / types) they're entitled to — exactly
// like the collaborators and API-token pages. When the approver does NOT
// own the requested Doco, the request can't be satisfied (granting some
// other Doco wouldn't help), so the screen BLOCKS: a terminal "you don't
// own that Doco — ask the agent to target a different one" message, with
// no picker.

import type { DocoRole } from "@doco/db";

export interface ApprovalDocoOption {
  id: string;
  handle: string;
  my_role: DocoRole;
  /** Owning workspace id for workspace-owned Docos, or null when owned directly. */
  workspace_id: string | null;
  /**
   * Owning workspace handle, so the picker can label its workspace bucket. The
   * builder always sets it; optional so callers/tests may omit it.
   */
  workspace_label?: string | null;
}

export interface ApprovalWorkspaceOption {
  id: string;
  handle: string;
  display_name: string;
  my_role: DocoRole;
}

export type ApprovalGrantView =
  | { blocked: false; docos: ApprovalDocoOption[]; workspaces: ApprovalWorkspaceOption[] }
  | { blocked: true; targetDocoHandle: string };

/**
 * Resolve what the approve screen shows for a requested target.
 *
 *   - No target, or a target Doco the approver owns → `blocked: false`
 *     with the full matrix (identical at every entry point; the target
 *     never strips scopes or narrows the list).
 *   - A target Doco the approver does NOT own → `blocked: true`. The
 *     request can't be satisfied, so the route shows only the terminal
 *     message (see `approvalTargetNotOwnedMessage`) — no picker.
 */
export function resolveApprovalGrantView(
  docos: ApprovalDocoOption[],
  workspaces: ApprovalWorkspaceOption[],
  targetDocoHandle: string | null | undefined,
): ApprovalGrantView {
  if (targetDocoHandle && !docos.some((d) => d.handle === targetDocoHandle)) {
    return { blocked: true, targetDocoHandle };
  }
  return { blocked: false, docos, workspaces };
}

/**
 * The terminal message shown when a client requested a Doco the approver
 * doesn't own. It names the Doco and points the user at the agent — it
 * does NOT suggest picking some other owned Doco, because that wouldn't
 * give the agent the access it asked for.
 */
export function approvalTargetNotOwnedMessage(targetDocoHandle: string): string {
  return `The token requested access to "${targetDocoHandle}", a Doco you don't own. Ask the agent to target a different one.`;
}

// ---------------------------------------------------------------------------
// Per-workspace MCP binding.
//
// An MCP connector lives at `/<workspace-id>/mcp` and authorizes against that
// URL (RFC 8707 `resource`), so a connector is bound to ONE workspace. When
// the authorize request carries that resource we scope the consent to just
// that workspace — the approver should never see, or be able to grant, any
// other workspace through a connector that can't reach it.
// ---------------------------------------------------------------------------

const WORKSPACE_RESOURCE_RE = /\/(workspace_[A-Za-z0-9]+)\/mcp(?:[/?#]|$)/;

/**
 * Pull the bound workspace id out of an OAuth `resource` value. Returns null
 * for anything that isn't a per-workspace MCP endpoint (missing param, an
 * app-wide URL, a Doco URL, …) so non-MCP flows keep the full picker.
 */
export function parseWorkspaceFromResource(resource: string | null | undefined): string | null {
  if (!resource) return null;
  const match = resource.match(WORKSPACE_RESOURCE_RE);
  return match ? match[1] : null;
}

export type BoundWorkspaceView =
  | { blocked: true; workspaceId: string }
  | {
      blocked: false;
      boundWorkspace: ApprovalWorkspaceOption;
      docos: ApprovalDocoOption[];
      workspaces: ApprovalWorkspaceOption[];
    };

/**
 * Narrow the approve screen to the one workspace an MCP connector is bound to.
 *
 *   - Approver owns it → show only that workspace and its Docos.
 *   - Approver doesn't own it → block: a connector for a workspace you don't
 *     own can't be authorized by you (granting anything else wouldn't help).
 */
export function scopeApprovalToBoundWorkspace(
  docos: ApprovalDocoOption[],
  workspaces: ApprovalWorkspaceOption[],
  workspaceId: string,
): BoundWorkspaceView {
  const boundWorkspace = workspaces.find((w) => w.id === workspaceId);
  if (!boundWorkspace) return { blocked: true, workspaceId };
  return {
    blocked: false,
    boundWorkspace,
    docos: docos.filter((d) => d.workspace_id === workspaceId),
    workspaces: [boundWorkspace],
  };
}

/** Terminal message when the connector's workspace isn't one the approver owns. */
export function boundWorkspaceNotOwnedMessage(workspaceId: string): string {
  return `This MCP connector is bound to the workspace ${workspaceId}, which you don't own. Ask one of its owners to authorize the connector, or connect to a workspace you own.`;
}
