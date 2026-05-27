import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withClient: vi.fn(),
  withTransaction: vi.fn(),
  generateUlid: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
  withTransaction: mocks.withTransaction,
}));

vi.mock("@doco/shared", () => ({
  generateUlid: mocks.generateUlid,
}));

import {
  approveDeviceAuthorization,
  issueAuthorizationCode,
  normalizeAgentName,
} from "../oauth-server.server";

describe("OAuth agent collaborator authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUlid.mockReturnValue("01AGENT0000000000000000000");
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (callback) =>
      callback({
        query: mocks.query,
      }),
    );
  });

  it("normalizes and requires an agent name", () => {
    expect(normalizeAgentName("  Codex   in repo  ")).toBe("Codex in repo");
    expect(() => normalizeAgentName("   ")).toThrow(/agent_name required/);
  });

  it("issues browser OAuth codes for a named agent collaborator", async () => {
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_collaborator_id: "collaborator_owner",
      agent_name: "  Claude   Code  ",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "author" },
      granted_org_ids: ["organization_torre"],
      granted_org_roles: { organization_torre: "reader" },
      scope: "doco",
    });

    const agentId = "collaborator_01AGENT0000000000000000000";
    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO collaborators"),
      expect.arrayContaining([agentId, "collaborator_owner"]),
    );
    const agentData = JSON.parse(mocks.query.mock.calls[0]?.[1]?.[2] as string);
    expect(agentData.name).toBe("Claude Code");
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO doco_users"),
      ["doco_bpms", agentId, "author"],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO org_users"),
      ["organization_torre", agentId, "reader"],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO oauth_authorization_codes"),
      expect.arrayContaining(["doco_client_browser", agentId]),
    );
  });

  it("approves device codes by binding the pending grant to the named agent", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT client_id")) {
        return { rows: [{ client_id: "doco_client_device" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_collaborator_id: "collaborator_owner",
      agent_name: "Codex sandbox",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "approver" },
      granted_org_ids: [],
      granted_org_roles: {},
    });

    const agentId = "collaborator_01AGENT0000000000000000000";
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO collaborators"),
      expect.arrayContaining([agentId, "collaborator_owner"]),
    );
    const agentData = JSON.parse(mocks.query.mock.calls[1]?.[1]?.[2] as string);
    expect(agentData.name).toBe("Codex sandbox");
    expect(mocks.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO doco_users"),
      ["doco_bpms", agentId, "approver"],
    );
    expect(mocks.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("UPDATE oauth_device_authorizations"),
      expect.arrayContaining(["doco_dc_123", agentId]),
    );
  });
});
