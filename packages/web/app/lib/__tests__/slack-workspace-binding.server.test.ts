import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withClient: vi.fn(),
  listAccessibleDocoIdsInWorkspace: vi.fn(),
  getDocoLevelRole: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {},
  DOCO_NODE_TABLE_SPECS: [],
  DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS: [],
  getUserById: vi.fn(),
  getEntity: vi.fn(),
  listDocoUsers: vi.fn(),
  listNodesByDoco: vi.fn(),
  withClient: mocks.withClient,
}));

vi.mock("../doco-access.server", () => ({
  listAccessibleDocoIdsInWorkspace: mocks.listAccessibleDocoIdsInWorkspace,
  getDocoLevelRole: mocks.getDocoLevelRole,
}));

import { listSlackChannelConnections, listSlackPersonalConnections } from "../slack.server";

describe("Slack team→workspace binding (fail-closed personal + channel access)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withClient.mockImplementation(async (cb) => cb({ query: mocks.query }));
  });

  it("personal access is empty (and account-wide reach is never consulted) when the team is unbound", async () => {
    const result = await listSlackPersonalConnections({
      workspaceId: "T_SLACK",
      chatUserId: "U1",
      boundWorkspaceId: null,
    });
    expect(result).toEqual({ actors: [], connections: [] });
    expect(mocks.listAccessibleDocoIdsInWorkspace).not.toHaveBeenCalled();
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("channel defaults are empty (no DB query) when the team is unbound", async () => {
    const result = await listSlackChannelConnections({
      workspaceId: "T_SLACK",
      channelId: "C1",
      boundWorkspaceId: null,
    });
    expect(result).toEqual([]);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("personal access is scoped to the bound Doco workspace only", async () => {
    // listSlackLinkedUsers → one linked user; the docos query → one Doco.
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM group_chat_user_links")) {
        return { rows: [{ user_id: "user_a", github_login: "alice", data: null }] };
      }
      if (String(sql).includes("FROM docos")) {
        return {
          rows: [
            { id: "doco_1", handle: "proj", owner_id: "workspace_bound", workspace_handle: "acme" },
          ],
        };
      }
      return { rows: [] };
    });
    mocks.listAccessibleDocoIdsInWorkspace.mockResolvedValue(["doco_1"]);
    mocks.getDocoLevelRole.mockResolvedValue("writer");

    const result = await listSlackPersonalConnections({
      workspaceId: "T_SLACK",
      chatUserId: "U1",
      boundWorkspaceId: "workspace_bound",
    });

    // The reach is computed against the BOUND workspace, never the whole account.
    expect(mocks.listAccessibleDocoIdsInWorkspace).toHaveBeenCalledWith(
      "user_a",
      "workspace_bound",
    );
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({
      targetId: "doco_1",
      role: "writer",
      source: "personal",
    });
  });

  it("channel-default query is constrained to the bound workspace", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await listSlackChannelConnections({
      workspaceId: "T_SLACK",
      channelId: "C1",
      boundWorkspaceId: "workspace_bound",
    });
    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("target_level = 'workspace' AND gcc.target_id = $3");
    expect(String(sql)).toContain("d.workspace_id = $3");
    expect(params).toContain("workspace_bound");
  });
});
