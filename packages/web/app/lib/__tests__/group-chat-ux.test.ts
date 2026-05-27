import { describe, expect, it } from "vitest";
import {
  type ChatAccessTarget,
  canChangePoliciesFromChat,
  canCreateDocoFromChat,
  canInviteCollaboratorFromChat,
  canSetChannelDefaultAccess,
  chatTargetLabel,
  formatAmbiguousTargetPrompt,
  formatChatAccessSummary,
  formatConnectionAuthorizationPreview,
  formatInviteDmResult,
  resolveEffectiveChatAccess,
} from "../group-chat-ux";

const channelAuthor: ChatAccessTarget = {
  level: "doco",
  orgHandle: "torre",
  docoHandle: "bpms",
  role: "author",
  source: "channel_default",
};

const personalOwner: ChatAccessTarget = {
  level: "doco",
  orgHandle: "torre",
  docoHandle: "bpms",
  role: "owner",
  source: "personal",
};

describe("group-chat UX helpers", () => {
  it("qualifies doco targets with the org handle", () => {
    expect(chatTargetLabel(channelAuthor)).toBe("torre/bpms");
    expect(
      chatTargetLabel({
        level: "org",
        orgHandle: "torre",
        role: "reader",
        source: "channel_default",
      }),
    ).toBe("torre/*");
  });

  it("resolves effective access to the strongest role per target", () => {
    const result = resolveEffectiveChatAccess([
      channelAuthor,
      personalOwner,
      {
        level: "doco",
        orgHandle: "acme",
        docoHandle: "launch",
        role: "reader",
        source: "channel_default",
      },
    ]);
    expect(result.map((target) => [chatTargetLabel(target), target.role, target.source])).toEqual([
      ["acme/launch", "reader", "channel_default"],
      ["torre/bpms", "owner", "personal"],
    ]);
  });

  it("gates create-doco and policy-change actions to owners", () => {
    expect(canCreateDocoFromChat("owner")).toBe(true);
    expect(canCreateDocoFromChat("approver")).toBe(false);
    expect(canChangePoliciesFromChat("owner")).toBe(true);
    expect(canChangePoliciesFromChat("author")).toBe(false);
  });

  it("allows collaborator invites at or below the inviter role", () => {
    expect(
      canInviteCollaboratorFromChat({ inviterRole: "author", requestedRole: "reader" }),
    ).toEqual({
      ok: true,
    });
    expect(
      canInviteCollaboratorFromChat({ inviterRole: "author", requestedRole: "approver" }),
    ).toMatchObject({
      ok: false,
      error: "Cannot invite at 'approver' because your access is 'author'.",
    });
  });

  it("caps shared-default authorization at the requester's personal access", () => {
    expect(
      canSetChannelDefaultAccess({ personalRole: "approver", requestedRole: "author" }),
    ).toEqual({ ok: true });
    expect(
      canSetChannelDefaultAccess({ personalRole: "author", requestedRole: "owner" }),
    ).toMatchObject({
      ok: false,
      error: "Cannot set default permissions 'owner' because your access is 'author'.",
    });
  });

  it("formats the explicit shared authorization preview", () => {
    const text = formatConnectionAuthorizationPreview({
      channelName: "#product",
      requesterLabel: "@ana",
      defaultTargets: [channelAuthor],
    });
    expect(text).toContain("Set the default permissions for Señor Doco?");
    expect(text).toContain("This will become the shared default access:");
    expect(text).toContain("• torre/bpms · author");
    expect(text).toContain(
      "If they already have higher access in Doco, Señor Doco may use that higher personal access, but never more than the access they already hold.",
    );
    expect(text).toContain(
      "Owner-only actions, including creating Docos and changing policies, require that individual person to be an owner in Doco.",
    );
  });

  it("formats access summaries with shared defaults and personal grants", () => {
    expect(
      formatChatAccessSummary({
        channelName: "#product",
        channelDefaults: [channelAuthor],
        personalTargets: [personalOwner],
        linkedAs: "torrenegra",
      }),
    ).toContain("• torre/bpms · owner");
  });

  it("formats ambiguous target prompts with qualified labels", () => {
    const text = formatAmbiguousTargetPrompt([
      channelAuthor,
      {
        level: "doco",
        orgHandle: "acme",
        docoHandle: "bpms",
        role: "reader",
        source: "channel_default",
      },
    ]);
    expect(text).toContain("1. acme/bpms · reader via shared default");
    expect(text).toContain("2. torre/bpms · author via shared default");
  });

  it("formats direct-message invite success and failure without exposing invite links publicly", () => {
    expect(
      formatInviteDmResult({
        status: "sent",
        recipientLabel: "@maria",
        target: personalOwner,
        role: "author",
        grantedByLabel: "torrenegra",
      }),
    ).toContain("I sent @maria a direct message with the torre/bpms invite.");

    const failure = formatInviteDmResult({
      status: "failed",
      recipientLabel: "@maria",
      target: personalOwner,
      role: "author",
      grantedByLabel: "torrenegra",
      reason: "Their Slack settings block bot DMs.",
    });
    expect(failure).toContain("No invite link was posted publicly.");
    expect(failure).toContain("Their Slack settings block bot DMs.");
  });
});
