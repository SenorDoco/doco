import type { DocoRole } from "@doco/db";
import { qualifiedDocoLabel, workspaceWideLabel } from "./doco-labels";

export type ChatGrantSource = "channel_default" | "personal";

export interface BaseChatAccessTarget {
  role: DocoRole;
  source: ChatGrantSource;
  actorLabel?: string;
}

export interface WorkspaceChatAccessTarget extends BaseChatAccessTarget {
  level: "workspace";
  workspaceHandle: string;
}

export interface DocoChatAccessTarget extends BaseChatAccessTarget {
  level: "doco";
  workspaceHandle: string;
  docoHandle: string;
}

export type ChatAccessTarget = WorkspaceChatAccessTarget | DocoChatAccessTarget;

export interface InviteCapability {
  ok: boolean;
  error?: string;
}

export interface InviteDmResult {
  status: "sent" | "failed";
  recipientLabel: string;
  target: ChatAccessTarget;
  role: DocoRole;
  grantedByLabel: string;
  reason?: string;
}

const ROLE_RANK: Record<DocoRole, number> = {
  owner: 2,
  writer: 1,
  reader: 0,
};

export function chatTargetKey(target: ChatAccessTarget): string {
  if (target.level === "workspace") return `workspace:${target.workspaceHandle}`;
  return `doco:${target.workspaceHandle}/${target.docoHandle}`;
}

export function chatTargetLabel(target: ChatAccessTarget): string {
  if (target.level === "workspace") return workspaceWideLabel(target.workspaceHandle);
  return qualifiedDocoLabel({ ownerSlug: target.workspaceHandle, handle: target.docoHandle });
}

export function grantSourceLabel(source: ChatGrantSource): string {
  return source === "personal" ? "your Doco account" : "shared default";
}

export function canCreateDocoFromChat(workspaceRole: DocoRole | null | undefined): boolean {
  return workspaceRole === "owner";
}

export function canChangePoliciesFromChat(docoRole: DocoRole | null | undefined): boolean {
  return docoRole === "owner";
}

export function canSetChannelDefaultAccess(args: {
  personalRole: DocoRole | null | undefined;
  requestedRole: DocoRole;
}): InviteCapability {
  if (!args.personalRole) {
    return { ok: false, error: "You do not hold a role on this target." };
  }
  if (ROLE_RANK[args.requestedRole] > ROLE_RANK[args.personalRole]) {
    return {
      ok: false,
      error: `Cannot set default permissions '${args.requestedRole}' because your access is '${args.personalRole}'.`,
    };
  }
  return { ok: true };
}

export function canInviteUserFromChat(args: {
  inviterRole: DocoRole | null | undefined;
  requestedRole: DocoRole;
}): InviteCapability {
  if (!args.inviterRole) {
    return { ok: false, error: "You do not hold a role on this target." };
  }
  if (ROLE_RANK[args.requestedRole] > ROLE_RANK[args.inviterRole]) {
    return {
      ok: false,
      error: `Cannot invite at '${args.requestedRole}' because your access is '${args.inviterRole}'.`,
    };
  }
  return { ok: true };
}

export function resolveEffectiveChatAccess(targets: ChatAccessTarget[]): ChatAccessTarget[] {
  const byKey = new Map<string, ChatAccessTarget>();
  for (const target of targets) {
    const key = chatTargetKey(target);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, target);
      continue;
    }
    const betterRole = ROLE_RANK[target.role] > ROLE_RANK[existing.role];
    const sameRolePersonal =
      ROLE_RANK[target.role] === ROLE_RANK[existing.role] &&
      target.source === "personal" &&
      existing.source !== "personal";
    if (betterRole || sameRolePersonal) byKey.set(key, target);
  }
  return [...byKey.values()].sort((a, b) => chatTargetLabel(a).localeCompare(chatTargetLabel(b)));
}

export function formatChatAccessSummary(args: {
  channelName: string;
  channelDefaults: ChatAccessTarget[];
  personalTargets?: ChatAccessTarget[];
  linkedAs?: string | null;
}): string {
  const lines = [`Señor Doco is connected to ${args.channelName}.`, ""];
  lines.push("Shared default access:");
  lines.push(...formatAccessBullets(args.channelDefaults));

  const personal = args.personalTargets ?? [];
  if (personal.length > 0) {
    lines.push("");
    lines.push(`Personal account: ${args.linkedAs ?? "linked"}`);
    lines.push(...formatAccessBullets(personal));
  } else {
    lines.push("");
    lines.push("Personal Doco account: not linked");
    lines.push("Run /doco connect to use your own higher access where you have it.");
  }

  return lines.join("\n");
}

export function formatConnectionAuthorizationPreview(args: {
  channelName: string;
  requesterLabel: string;
  defaultTargets: ChatAccessTarget[];
}): string {
  return [
    "Set the default permissions for Señor Doco?",
    "",
    "This will become the shared default access:",
    ...formatAccessBullets(args.defaultTargets),
    "",
    `Requested by: ${args.requesterLabel}`,
    "This is the default for Señor Doco. Everyone in this chat can use it.",
    "Each person can also link their own Doco account. If they already have higher access in Doco, Señor Doco may use that higher personal access, but never more than the access they already hold.",
    "Owner-only actions, including creating Docos and changing policies, require that individual person to be an owner in Doco.",
    "User invites are sent by direct message and cannot grant above the inviter's role.",
  ].join("\n");
}

export function formatAmbiguousTargetPrompt(targets: ChatAccessTarget[]): string {
  const effective = resolveEffectiveChatAccess(targets);
  return [
    "This channel is connected to multiple targets.",
    "",
    "Pick a target:",
    ...effective.map(
      (target, index) =>
        `${index + 1}. ${chatTargetLabel(target)} · ${target.role} via ${grantSourceLabel(
          target.source,
        )}`,
    ),
    "",
    'Reply with the number or say "use workspace/doco".',
  ].join("\n");
}

export function formatInviteDmResult(result: InviteDmResult): string {
  const label = chatTargetLabel(result.target);
  if (result.status === "sent") {
    return [
      `${result.recipientLabel} was sent a direct message with the ${label} invite.`,
      "",
      `Invite role: ${result.role}`,
      `Granted by: ${result.grantedByLabel} · ${result.target.role}`,
    ].join("\n");
  }
  return [
    `${result.recipientLabel} could not be sent a direct message.`,
    result.reason ? result.reason : "Their chat settings may block bot DMs.",
    "",
    "No invite link was posted publicly.",
    "Ask them to message Señor Doco first, then retry the invite.",
  ].join("\n");
}

function formatAccessBullets(targets: ChatAccessTarget[]): string[] {
  const effective = resolveEffectiveChatAccess(targets);
  if (effective.length === 0) return ["• none"];
  return effective.map((target) => `• ${chatTargetLabel(target)} · ${target.role}`);
}
