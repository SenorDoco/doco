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
  normalizeTokenName,
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

describe("OAuth token authorization", () => {
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

  it("normalizes and requires a token name", () => {
    expect(normalizeTokenName("  Codex   in repo  ")).toBe("Codex in repo");
    expect(() => normalizeTokenName("   ")).toThrow(/token_name required/);
  });

  it("issues browser OAuth codes for the approving user and stores the token name", async () => {
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_user_id: "user_owner",
      token_name: "  Claude   Code  ",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "writer" },
      granted_org_ids: ["organization_torre"],
      granted_org_roles: { organization_torre: "reader" },
      scope: "doco",
    });

    expect(callsTo("kind = 'agent'")).toHaveLength(0);
    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);
    expect(callsTo("INSERT INTO org_users")).toHaveLength(0);

    // The minted code carries the approving human id, token name, and the approved grants.
    const codeInsert = callsTo("INSERT INTO oauth_authorization_codes")[0];
    expect(codeInsert?.[1]).toEqual(expect.arrayContaining(["doco_client_browser", "user_owner"]));
    expect((codeInsert?.[1] as unknown[])[4]).toBe("Claude Code");
    expect((codeInsert?.[1] as unknown[])[6]).toEqual(["doco_bpms"]);
  });

  it("approves device codes by binding the pending grant to the approving user and token name", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT client_id")) {
        return { rows: [{ client_id: "doco_client_device" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      token_name: "Codex sandbox",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "writer" },
      granted_org_ids: [],
      granted_org_roles: {},
    });

    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);
    const update = callsTo("UPDATE oauth_device_authorizations")[0];
    expect(update?.[1]).toEqual(expect.arrayContaining(["doco_dc_123", "user_owner"]));
    expect((update?.[1] as unknown[])[2]).toBe("Codex sandbox");
  });

  it("re-authorizing a client records exactly the newly approved token grants", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT client_id")) {
        return { rows: [{ client_id: "doco_client_device" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      token_name: "Codex sandbox",
      granted_doco_ids: ["doco_new"],
      granted_doco_roles: { doco_new: "writer" },
      granted_org_ids: [],
      granted_org_roles: {},
    });

    // Tokens do not create or reuse agent users.
    expect(callsTo("kind = 'agent'")).toHaveLength(0);
    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);

    // The device row is bound to the approving user and the approved set only.
    const update = callsTo("UPDATE oauth_device_authorizations")[0];
    expect((update?.[1] as unknown[])[1]).toBe("user_owner");
    expect((update?.[1] as unknown[])[3]).toEqual(["doco_new"]);
    const roles = JSON.parse((update?.[1] as unknown[])[4] as string);
    expect(roles).toEqual({ doco_new: "writer" });
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
