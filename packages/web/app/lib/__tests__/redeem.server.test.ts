import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createHostDocoInOrg: vi.fn(),
  createConversation: vi.fn(),
}));

vi.mock("@doco/host", () => ({
  addOrganizationByHandle: vi.fn(),
  createDocoInOrg: mocks.createHostDocoInOrg,
  ensurePersonalOrganization: vi.fn(),
  findAvailableDocoHandle: vi.fn(),
  findAvailableOrgHandle: vi.fn(),
  findDocoTemplate: vi.fn(),
  renameDocoHandle: vi.fn(),
  softDeleteDoco: vi.fn(),
  updateDocoMeta: vi.fn(),
}));

vi.mock("@doco/index", () => ({
  reindex: vi.fn(),
}));

vi.mock("../agent-chat.server", () => ({
  createConversation: mocks.createConversation,
}));

import { createDocoInOrg, createdDocoChatTitle } from "../redeem.server";

describe("createDocoInOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createHostDocoInOrg.mockResolvedValue({
      docoId: "doco_01",
      orgId: "org_01",
      orgHandle: "acme",
      handle: "acme-onboarding",
      goal: "Onboard customers",
    });
    mocks.createConversation.mockResolvedValue({ id: "conv_01" });
  });

  it("creates a companion chat attached to the new Doco", async () => {
    const rec = await createDocoInOrg({
      orgId: "org_01",
      requestedHandle: "acme-onboarding",
      createdByCollaboratorId: "collaborator_01",
      visibility: "private",
      templateHandle: null,
    });

    expect(mocks.createHostDocoInOrg).toHaveBeenCalledWith({
      orgId: "org_01",
      requestedHandle: "acme-onboarding",
      createdByCollaboratorId: "collaborator_01",
      visibility: "private",
      templateHandle: null,
    });
    expect(mocks.createConversation).toHaveBeenCalledWith("collaborator_01", {
      title: "Chat for acme-onboarding",
      attachedDocoIds: ["doco_01"],
    });
    expect(rec).toMatchObject({
      docoId: "doco_01",
      handle: "acme-onboarding",
      companionChatId: "conv_01",
    });
  });

  it("names companion chats from the Doco handle", () => {
    expect(createdDocoChatTitle("acme-onboarding")).toBe("Chat for acme-onboarding");
  });
});
