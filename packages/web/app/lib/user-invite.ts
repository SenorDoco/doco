import type { DocoRole } from "@doco/db";

export const ALL_ROLES: DocoRole[] = ["owner", "writer", "reader"];

export type InviteLevel = "workspace" | "doco";
export type InviteOption = {
  id: string;
  label: string;
  maxRole: DocoRole;
  /** Owning workspace id (doco options only) — groups docos under their workspace. */
  workspaceId?: string;
};
export type InviteDefaultSelection = { level: InviteLevel; targetId: string };

export interface UserInviteData {
  workspaces: InviteOption[];
  docos: InviteOption[];
  defaultSelection: InviteDefaultSelection;
}

export type UserInviteActionResult =
  | {
      intent: "invite";
      ok: true;
      invite_url: string;
      doco_url: string;
      recipe_url: string;
      device_url: string;
      invite_expires_at: string;
      level: InviteLevel;
      role: DocoRole;
    }
  | { error: string };

export function rankOf(role: DocoRole): number {
  return role === "owner" ? 2 : role === "writer" ? 1 : 0;
}

export function parseInviteLevel(value: string | null): InviteLevel | null {
  return value === "workspace" || value === "doco" ? value : null;
}

export function optionsForInviteLevel(
  level: InviteLevel,
  options: {
    workspaces: InviteOption[];
    docos: InviteOption[];
  },
): InviteOption[] {
  if (level === "workspace") return options.workspaces;
  return options.docos;
}

export function firstAvailableInviteLevel(options: {
  workspaces: InviteOption[];
  docos: InviteOption[];
}): InviteLevel {
  if (options.docos.length > 0) return "doco";
  return "workspace";
}

export function resolveInviteDefaultSelection(args: {
  requestedLevel: InviteLevel | null;
  requestedTargetId: string;
  workspaces: InviteOption[];
  docos: InviteOption[];
}): InviteDefaultSelection {
  const level =
    args.requestedLevel ??
    firstAvailableInviteLevel({ workspaces: args.workspaces, docos: args.docos });
  const options = optionsForInviteLevel(level, args);
  const targetId = options.some((opt) => opt.id === args.requestedTargetId)
    ? args.requestedTargetId
    : (options[0]?.id ?? "");
  return { level, targetId };
}

/**
 * One grant carried by a multi-grant invite (one link, all grants). The
 * redeemer receives every spec on consume. Every spec names a concrete,
 * existing target — a person is only ever granted specific workspaces or docos.
 */
export interface InviteGrantSpec {
  level: "workspace" | "doco";
  target_id: string;
  role: DocoRole;
  write_types: string[];
}
