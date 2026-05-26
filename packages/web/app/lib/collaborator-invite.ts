import type { DocoRole } from "@doco/db";

export const ALL_ROLES: DocoRole[] = ["owner", "approver", "author", "reader"];

export type InviteLevel = "org" | "doco";
export type InviteOption = { id: string; label: string; maxRole: DocoRole };
export type InviteDefaultSelection = { level: InviteLevel; targetId: string };

export interface CollaboratorInviteData {
  orgs: InviteOption[];
  docos: InviteOption[];
  defaultSelection: InviteDefaultSelection;
}

export type CollaboratorInviteActionResult =
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
  return role === "owner" ? 3 : role === "approver" ? 2 : role === "author" ? 1 : 0;
}

export function parseInviteLevel(value: string | null): InviteLevel | null {
  return value === "org" || value === "doco" ? value : null;
}

export function optionsForInviteLevel(
  level: InviteLevel,
  options: {
    orgs: InviteOption[];
    docos: InviteOption[];
  },
): InviteOption[] {
  if (level === "org") return options.orgs;
  return options.docos;
}

export function firstAvailableInviteLevel(options: {
  orgs: InviteOption[];
  docos: InviteOption[];
}): InviteLevel {
  if (options.docos.length > 0) return "doco";
  return "org";
}

export function resolveInviteDefaultSelection(args: {
  requestedLevel: InviteLevel | null;
  requestedTargetId: string;
  orgs: InviteOption[];
  docos: InviteOption[];
}): InviteDefaultSelection {
  const level =
    args.requestedLevel ?? firstAvailableInviteLevel({ orgs: args.orgs, docos: args.docos });
  const options = optionsForInviteLevel(level, args);
  const targetId = options.some((opt) => opt.id === args.requestedTargetId)
    ? args.requestedTargetId
    : (options[0]?.id ?? "");
  return { level, targetId };
}
