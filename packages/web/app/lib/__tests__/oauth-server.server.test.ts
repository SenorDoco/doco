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
  type GrantSets,
  approveDeviceAuthorization,
  issueAuthorizationCode,
  mergeGrantSets,
  normalizeAgentName,
} from "../oauth-server.server";

/** Calls whose SQL contains `fragment`, in invocation order. */
function callsTo(fragment: string): unknown[][] {
  return mocks.query.mock.calls.filter((c) => String(c[0]).includes(fragment));
}

const emptyGrants: GrantSets = {
  granted_doco_ids: [],
  granted_doco_roles: {},
  granted_org_ids: [],
  granted_org_roles: {},
};

describe("OAuth agent user authorization", () => {
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

  it("issues browser OAuth codes for a named agent user (first authorization)", async () => {
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_user_id: "user_owner",
      agent_name: "  Claude   Code  ",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "writer" },
      granted_org_ids: ["organization_torre"],
      granted_org_roles: { organization_torre: "reader" },
      scope: "doco",
    });

    const agentId = "user_01AGENT0000000000000000000";
    // Looks for an existing agent first; default mock returns none.
    expect(callsTo("kind = 'agent'")).toHaveLength(1);
    // No existing agent → creates one.
    const userInsert = callsTo("INSERT INTO users")[0];
    expect(userInsert?.[1]).toEqual(expect.arrayContaining([agentId, "user_owner"]));
    const agentData = JSON.parse((userInsert?.[1] as unknown[])[2] as string);
    expect(agentData.name).toBe("Claude Code");
    expect(agentData.oauth_client_id).toBe("doco_client_browser");

    expect(callsTo("INSERT INTO doco_users")[0]?.[1]).toEqual(["doco_bpms", agentId, "writer"]);
    expect(callsTo("INSERT INTO org_users")[0]?.[1]).toEqual([
      "organization_torre",
      agentId,
      "reader",
    ]);
    // The minted code carries the agent id + the approved grants.
    const codeInsert = callsTo("INSERT INTO oauth_authorization_codes")[0];
    expect(codeInsert?.[1]).toEqual(expect.arrayContaining(["doco_client_browser", agentId]));
    expect((codeInsert?.[1] as unknown[])[5]).toEqual(["doco_bpms"]);
  });

  it("approves device codes by binding the pending grant to a fresh named agent", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT client_id")) {
        return { rows: [{ client_id: "doco_client_device" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      agent_name: "Codex sandbox",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "writer" },
      granted_org_ids: [],
      granted_org_roles: {},
    });

    const agentId = "user_01AGENT0000000000000000000";
    const userInsert = callsTo("INSERT INTO users")[0];
    expect(userInsert?.[1]).toEqual(expect.arrayContaining([agentId, "user_owner"]));
    const agentData = JSON.parse((userInsert?.[1] as unknown[])[2] as string);
    expect(agentData.name).toBe("Codex sandbox");
    expect(callsTo("INSERT INTO doco_users")[0]?.[1]).toEqual(["doco_bpms", agentId, "writer"]);
    const update = callsTo("UPDATE oauth_device_authorizations")[0];
    expect(update?.[1]).toEqual(expect.arrayContaining(["doco_dc_123", agentId]));
  });

  it("re-authorizing an existing agent merges grants onto the same identity", async () => {
    // Existing agent already holds reader on doco_old; approval adds
    // author on doco_new.
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT client_id")) {
        return { rows: [{ client_id: "doco_client_device" }], rowCount: 1 };
      }
      if (sql.includes("kind = 'agent'")) {
        return { rows: [{ id: "user_existing" }], rowCount: 1 };
      }
      if (sql.includes("SELECT doco_id, role FROM doco_users")) {
        return { rows: [{ doco_id: "doco_old", role: "reader" }], rowCount: 1 };
      }
      if (sql.includes("SELECT org_id, role FROM org_users")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      agent_name: "Codex sandbox",
      granted_doco_ids: ["doco_new"],
      granted_doco_roles: { doco_new: "writer" },
      granted_org_ids: [],
      granted_org_roles: {},
    });

    // Reuse: NO new users row is minted.
    expect(callsTo("INSERT INTO users")).toHaveLength(0);

    // Memberships upserted for BOTH the old and the newly approved Doco.
    const upsertedDocoIds = callsTo("INSERT INTO doco_users").map((c) => (c[1] as unknown[])[0]);
    expect(upsertedDocoIds).toEqual(expect.arrayContaining(["doco_old", "doco_new"]));

    // The device row is bound to the existing agent and the merged set.
    const update = callsTo("UPDATE oauth_device_authorizations")[0];
    expect((update?.[1] as unknown[])[1]).toBe("user_existing");
    expect((update?.[1] as unknown[])[2]).toEqual(expect.arrayContaining(["doco_old", "doco_new"]));
    const mergedRoles = JSON.parse((update?.[1] as unknown[])[3] as string);
    expect(mergedRoles).toMatchObject({ doco_old: "reader", doco_new: "writer" });
  });
});

describe("mergeGrantSets", () => {
  it("unions disjoint Doco and org grants", () => {
    const merged = mergeGrantSets(
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "reader" } },
      {
        ...emptyGrants,
        granted_doco_ids: ["b"],
        granted_doco_roles: { b: "writer" },
        granted_org_ids: ["organization_x"],
        granted_org_roles: { organization_x: "owner" },
      },
    );
    expect(merged.granted_doco_ids).toEqual(["a", "b"]);
    expect(merged.granted_doco_roles).toEqual({ a: "reader", b: "writer" });
    expect(merged.granted_org_ids).toEqual(["organization_x"]);
    expect(merged.granted_org_roles).toEqual({ organization_x: "owner" });
  });

  it("keeps the STRONGER role when an id appears in both sets", () => {
    const merged = mergeGrantSets(
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "reader" } },
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "owner" } },
    );
    expect(merged.granted_doco_roles.a).toBe("owner");

    const merged2 = mergeGrantSets(
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "writer" } },
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "writer" } },
    );
    expect(merged2.granted_doco_roles.a).toBe("writer");
  });

  it("never drops an existing grant the incoming approval omits", () => {
    const merged = mergeGrantSets(
      {
        ...emptyGrants,
        granted_org_ids: ["organization_x"],
        granted_org_roles: { organization_x: "writer" },
      },
      emptyGrants,
    );
    expect(merged.granted_org_ids).toEqual(["organization_x"]);
    expect(merged.granted_org_roles.organization_x).toBe("writer");
  });
});
