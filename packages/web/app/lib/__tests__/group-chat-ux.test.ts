import { describe, expect, it } from "vitest";
import {
  type ChatAccessTarget,
  canChangePoliciesFromChat,
  canCreateDocoFromChat,
  canInviteUserFromChat,
  canSetChannelDefaultAccess,
  chatTargetLabel,
  formatAmbiguousTargetPrompt,
  formatChatAccessSummary,
  formatConnectionAuthorizationPreview,
  formatInviteDmResult,
  resolveEffectiveChatAccess,
} from "../group-chat-ux";

const channelWriter: ChatAccessTarget = {
  level: "doco",
  workspaceHandle: "torre",
  docoHandle: "bpms",
  role: "writer",
  source: "channel_default",
};

const personalOwner: ChatAccessTarget = {
  level: "doco",
  workspaceHandle: "torre",
  docoHandle: "bpms",
  role: "owner",
  source: "personal",
};

describe("group-chat UX helpers", () => {
  it("qualifies doco targets with the workspace handle", () => {
    expect(chatTargetLabel(channelWriter)).toBe("torre/bpms");
    expect(
      chatTargetLabel({
        level: "workspace",
        workspaceHandle: "torre",
        role: "reader",
        source: "channel_default",
      }),
    ).toBe("torre/*");
  });

  it("resolves effective access to the strongest role per target", () => {
    const result = resolveEffectiveChatAccess([
      channelWriter,
      personalOwner,
      {
        level: "doco",
        workspaceHandle: "acme",
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
    expect(canCreateDocoFromChat("writer")).toBe(false);
    expect(canChangePoliciesFromChat("owner")).toBe(true);
    expect(canChangePoliciesFromChat("writer")).toBe(false);
  });

  it("allows user invites at or below the inviter role", () => {
    expect(canInviteUserFromChat({ inviterRole: "writer", requestedRole: "reader" })).toEqual({
      ok: true,
    });
    expect(canInviteUserFromChat({ inviterRole: "writer", requestedRole: "owner" })).toMatchObject({
      ok: false,
      error: "Cannot invite at 'owner' because your access is 'writer'.",
    });
  });

  it("caps shared-default authorization at the requester's personal access", () => {
    expect(canSetChannelDefaultAccess({ personalRole: "writer", requestedRole: "reader" })).toEqual(
      { ok: true },
    );
    expect(
      canSetChannelDefaultAccess({ personalRole: "writer", requestedRole: "owner" }),
    ).toMatchObject({
      ok: false,
      error: "Cannot set default permissions 'owner' because your access is 'writer'.",
    });
  });

  it("formats the explicit shared authorization preview", () => {
    const text = formatConnectionAuthorizationPreview({
      channelName: "#product",
      requesterLabel: "@ana",
      defaultTargets: [channelWriter],
    });
    expect(text).toContain("Set the default permissions for Señor Doco?");
    expect(text).toContain("This will become the shared default access:");
    expect(text).toContain("• torre/bpms · writer");
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
        channelDefaults: [channelWriter],
        personalTargets: [personalOwner],
        linkedAs: "torrenegra",
      }),
    ).toContain("• torre/bpms · owner");
  });

  it("formats ambiguous target prompts with qualified labels", () => {
    const text = formatAmbiguousTargetPrompt([
      channelWriter,
      {
        level: "doco",
        workspaceHandle: "acme",
        docoHandle: "bpms",
        role: "reader",
        source: "channel_default",
      },
    ]);
    expect(text).toContain("1. acme/bpms · reader via shared default");
    expect(text).toContain("2. torre/bpms · writer via shared default");
  });

  it("formats direct-message invite success and failure without exposing invite links publicly", () => {
    expect(
      formatInviteDmResult({
        status: "sent",
        recipientLabel: "@maria",
        target: personalOwner,
        role: "writer",
        grantedByLabel: "torrenegra",
      }),
    ).toContain("I sent @maria a direct message with the torre/bpms invite.");

    const failure = formatInviteDmResult({
      status: "failed",
      recipientLabel: "@maria",
      target: personalOwner,
      role: "writer",
      grantedByLabel: "torrenegra",
      reason: "Their Slack settings block bot DMs.",
    });
    expect(failure).toContain("No invite link was posted publicly.");
    expect(failure).toContain("Their Slack settings block bot DMs.");
  });
});
