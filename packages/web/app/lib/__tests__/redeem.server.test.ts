import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createHostDocoInOrg: vi.fn(),
  createConversation: vi.fn(),
  markDocoPerspectiveLayoutsDirty: vi.fn(),
  NoopEmbeddingProvider: class NoopEmbeddingProvider {},
  reindexBare: vi.fn(),
  withClient: vi.fn(),
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
  NoopEmbeddingProvider: mocks.NoopEmbeddingProvider,
  getDefaultEmbeddingProvider: () => new mocks.NoopEmbeddingProvider(),
  reindex: mocks.reindexBare,
}));

vi.mock("@doco/db", () => ({ withClient: mocks.withClient }));

vi.mock("../agent-chat.server", () => ({
  createConversation: mocks.createConversation,
}));

vi.mock("../perspective-layout.server", () => ({
  markDocoPerspectiveLayoutsDirty: mocks.markDocoPerspectiveLayoutsDirty,
}));

import { createDocoInOrg, createdDocoChatTitle, reindex } from "../redeem.server";

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
    mocks.reindexBare.mockResolvedValue({ loadMs: 12, loadedEntityCount: 1 });
    mocks.withClient.mockImplementation((fn) => fn({ query: vi.fn() }));
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

describe("reindex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reindexBare.mockResolvedValue({ loadMs: 12, loadedEntityCount: 1 });
    mocks.withClient.mockImplementation((fn) => fn({ query: vi.fn() }));
  });

  it("marks perspective layouts dirty after structural reindex", async () => {
    await reindex("/tmp/doco", "doco_01", ["decision_01"], { skipEmbeddings: true });

    expect(mocks.reindexBare).toHaveBeenCalledWith("/tmp/doco", {
      docoId: "doco_01",
      changedEntityIds: ["decision_01"],
      skipEmbeddings: true,
    });
    expect(mocks.markDocoPerspectiveLayoutsDirty).toHaveBeenCalledWith(expect.anything(), {
      docoId: "doco_01",
      changedEntityIds: ["decision_01"],
      reason: "reindex",
    });
  });

  it("does not dirty layouts during the embeddings-only phase", async () => {
    await reindex("/tmp/doco", "doco_01", ["decision_01"], { skipStructural: true });

    expect(mocks.markDocoPerspectiveLayoutsDirty).not.toHaveBeenCalled();
  });
});
