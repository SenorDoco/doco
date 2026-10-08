import { createHash } from "node:crypto";
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
  assertScopedGrant,
  consumeAuthorizationCode,
  issueAuthorizationCode,
  issueTokens,
  mergeGrantSets,
  pollDeviceAuthorization,
  refreshTokens,
} from "../oauth-server.server";

/** Calls whose SQL contains `fragment`, in invocation order. */
function callsTo(fragment: string): unknown[][] {
  return mocks.query.mock.calls.filter((c) => String(c[0]).includes(fragment));
}

const emptyGrants: GrantSets = {
  granted_doco_ids: [],
  granted_doco_roles: {},
  granted_doco_write_types: {},
  granted_workspace_ids: [],
  granted_workspace_roles: {},
  granted_workspace_write_types: {},
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
    mocks.withClient.mockImplementation(async (callback) =>
      callback({
        query: mocks.query,
      }),
    );
  });

  it("refreshTokens reissues the access token but keeps the same refresh token (non-rotating)", async () => {
    const refreshRow = {
      client_id: "doco_client_x",
      user_id: "user_a",
      token_name: "t",
      granted_doco_ids: ["doco_1"],
      granted_doco_roles: {},
      granted_doco_write_types: {},
      granted_workspace_ids: [],
      granted_workspace_roles: {},
      granted_workspace_write_types: {},
      scope: "doco",
      expires_at: new Date(Date.now() + 10_000_000),
      revoked: false,
    };
    mocks.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM oauth_refresh_tokens")
        ? { rows: [refreshRow], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    const result = await refreshTokens({
      client_id: "doco_client_x",
      refresh_token: "doco_rt_original",
    });

    // Non-rotating: the same refresh token comes back, a fresh access token
    // is minted, no new refresh row is created, the old one is not revoked —
    // only its expiry slides forward.
    expect(result.refresh_token).toBe("doco_rt_original");
    expect(result.access_token).toMatch(/^doco_at_/);
    expect(callsTo("INSERT INTO oauth_refresh_tokens")).toHaveLength(0);
    expect(callsTo("SET revoked = true")).toHaveLength(0);
    expect(callsTo("UPDATE oauth_refresh_tokens SET expires_at")).toHaveLength(1);
  });

  // An actor token carries NO stored grants — it acts as its user, capped at
  // actor_role, resolved LIVE by the access gate on every request. So both the
  // refresh exchange and the authorization-code exchange mint an UNSCOPED access
  // token that simply carries the grant_type/actor_role marker (no `resource`,
  // no per-workspace pinning at mint).
  const actorRefreshRow = {
    client_id: "doco_client_x",
    user_id: "user_a",
    token_name: "actor key",
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_workspace_ids: [],
    granted_workspace_roles: {},
    granted_workspace_write_types: {},
    grant_type: "actor",
    actor_role: null,
    scope: "doco",
    expires_at: new Date(Date.now() + 10_000_000),
    revoked: false,
  };

  it("an actor refresh reissues an unscoped access token carrying the actor marker", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM oauth_refresh_tokens")
        ? { rows: [{ ...actorRefreshRow, actor_role: "writer" }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    const result = await refreshTokens({
      client_id: "doco_client_x",
      refresh_token: "doco_rt_actor",
    });

    expect(result.access_token).toMatch(/^doco_at_/);
    const access = callsTo("INSERT INTO oauth_access_tokens")[0]?.[1] as unknown[];
    // No stored grants — the gate resolves access live from the user's membership.
    expect(access[4]).toEqual([]); // granted_doco_ids
    expect(access[7]).toEqual([]); // granted_workspace_ids
    // The actor authority rides on the access token: grant_type + role ceiling.
    expect(access[12]).toBe("actor");
    expect(access[13]).toBe("writer");
    // No per-workspace membership lookup happens at mint anymore.
    expect(callsTo("FROM workspace_users")).toHaveLength(0);
  });

  it("a regular refresh copies its explicit grant through and stays 'regular'", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      String(sql).includes("FROM oauth_refresh_tokens")
        ? {
            rows: [
              {
                ...actorRefreshRow,
                grant_type: "regular",
                actor_role: null,
                granted_workspace_ids: ["workspace_a"],
                granted_workspace_roles: { workspace_a: "writer" },
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 1 },
    );
    await refreshTokens({ client_id: "doco_client_x", refresh_token: "doco_rt_reg" });
    const access = callsTo("INSERT INTO oauth_access_tokens")[0]?.[1] as unknown[];
    expect(access[7]).toEqual(["workspace_a"]);
    expect(JSON.parse(access[8] as string)).toEqual({ workspace_a: "writer" });
    expect(access[12]).toBe("regular");
    expect(access[13]).toBeNull();
  });

  const actorIssueInput = {
    client_id: "doco_client_x",
    user_id: "user_a",
    token_name: "actor key",
    granted_doco_ids: [] as string[],
    granted_workspace_ids: [] as string[],
    scope: "doco" as string | null,
    grant_type: "actor" as const,
    actor_role: null as null | "reader" | "writer" | "owner",
  };

  it("an actor authorization-code exchange mints an unscoped access token + marker", async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const result = await issueTokens({ ...actorIssueInput, actor_role: "writer" });

    expect(result.access_token).toMatch(/^doco_at_/);
    const access = callsTo("INSERT INTO oauth_access_tokens")[0]?.[1] as unknown[];
    expect(access[4]).toEqual([]); // no doco grants
    expect(access[7]).toEqual([]); // no workspace grants
    expect(access[12]).toBe("actor");
    expect(access[13]).toBe("writer");
    // The refresh token carries the same marker.
    const refresh = callsTo("INSERT INTO oauth_refresh_tokens")[0]?.[1] as unknown[];
    expect(refresh[12]).toBe("actor");
    expect(refresh[13]).toBe("writer");
  });

  // One-click Allow (decision_01M4EQPJ6AKETJ1508W254DXVB): approving names
  // no token; the connection goes by its client's name.
  it("issues browser OAuth codes for the approving user, with no token name", async () => {
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_user_id: "user_owner",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "writer" },
      granted_doco_write_types: { doco_bpms: ["decision"] },
      granted_workspace_ids: ["workspace_torre"],
      granted_workspace_roles: { workspace_torre: "reader" },
      granted_workspace_write_types: { workspace_torre: ["intent"] },
      scope: "doco",
    });

    expect(callsTo("kind = 'agent'")).toHaveLength(0);
    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);
    expect(callsTo("INSERT INTO workspace_users")).toHaveLength(0);

    // The minted code carries the approving human id and the approved grants.
    const codeInsert = callsTo("INSERT INTO oauth_authorization_codes")[0];
    expect(String(codeInsert?.[0])).not.toContain("token_name");
    expect(codeInsert?.[1]).toEqual(expect.arrayContaining(["doco_client_browser", "user_owner"]));
    expect((codeInsert?.[1] as unknown[])[5]).toEqual(["doco_bpms"]);
    expect(JSON.parse((codeInsert?.[1] as unknown[])[7] as string)).toEqual({
      doco_bpms: ["decision"],
    });
    expect(JSON.parse((codeInsert?.[1] as unknown[])[10] as string)).toEqual({
      workspace_torre: ["intent"],
    });
  });

  it("approves device codes by binding the pending grant to the approving user, with no token name", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT client_id")) {
        return { rows: [{ client_id: "doco_client_device" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      granted_doco_ids: ["doco_bpms"],
      granted_doco_roles: { doco_bpms: "writer" },
      granted_doco_write_types: { doco_bpms: ["decision"] },
      granted_workspace_ids: [],
      granted_workspace_roles: {},
      granted_workspace_write_types: {},
    });

    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);
    const update = callsTo("UPDATE oauth_device_authorizations")[0];
    expect(String(update?.[0])).not.toContain("token_name");
    expect(update?.[1]).toEqual(expect.arrayContaining(["doco_dc_123", "user_owner"]));
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
      granted_doco_ids: ["doco_new"],
      granted_doco_roles: { doco_new: "writer" },
      granted_doco_write_types: { doco_new: ["intent"] },
      granted_workspace_ids: [],
      granted_workspace_roles: {},
      granted_workspace_write_types: {},
    });

    // Tokens do not create or reuse agent users.
    expect(callsTo("kind = 'agent'")).toHaveLength(0);
    expect(callsTo("INSERT INTO users")).toHaveLength(0);
    expect(callsTo("INSERT INTO doco_users")).toHaveLength(0);

    // The device row is bound to the approving user and the approved set only.
    const update = callsTo("UPDATE oauth_device_authorizations")[0];
    expect((update?.[1] as unknown[])[1]).toBe("user_owner");
    expect((update?.[1] as unknown[])[2]).toEqual(["doco_new"]);
    const roles = JSON.parse((update?.[1] as unknown[])[3] as string);
    expect(roles).toEqual({ doco_new: "writer" });
    const writeTypes = JSON.parse((update?.[1] as unknown[])[4] as string);
    expect(writeTypes).toEqual({ doco_new: ["intent"] });
  });
});

// The consent screens can mint an "all workspaces" credential: grant_type='actor',
// no explicit grants, breadth resolved live. These tests pin the value as it threads through the
// authorization-code and device-code paths.
describe("actor grant_type threads through the consent paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUlid.mockReturnValue("01AGENT0000000000000000000");
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (callback) => callback({ query: mocks.query }));
    mocks.withClient.mockImplementation(async (callback) => callback({ query: mocks.query }));
  });

  it("issueAuthorizationCode persists grant_type (actor), defaulting to regular", async () => {
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_user_id: "user_owner",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: [],
      granted_workspace_ids: [],
      grant_type: "actor",
      actor_role: "reader",
      scope: "doco",
    });
    const actorInsert = callsTo("INSERT INTO oauth_authorization_codes")[0]?.[1] as unknown[];
    // …grant_type + actor_role land right after scope, before expires_at.
    expect(actorInsert[11]).toBe("doco"); // scope
    expect(actorInsert[12]).toBe("actor"); // grant_type
    expect(actorInsert[13]).toBe("reader"); // actor_role ceiling

    vi.clearAllMocks();
    await issueAuthorizationCode({
      client_id: "doco_client_browser",
      approver_user_id: "user_owner",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: ["doco_bpms"],
      granted_workspace_ids: [],
      scope: "doco",
    });
    const regularInsert = callsTo("INSERT INTO oauth_authorization_codes")[0]?.[1] as unknown[];
    expect(regularInsert[12]).toBe("regular");
    expect(regularInsert[13]).toBeNull(); // no ceiling on a regular grant
  });

  it("consumeAuthorizationCode returns the stored grant_type", async () => {
    const verifier = "consume-test-verifier-0123456789";
    const code_challenge = createHash("sha256").update(verifier).digest("base64url");
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM oauth_authorization_codes")) {
        return {
          rows: [
            {
              client_id: "doco_client_browser",
              user_id: "user_owner",
              redirect_uri: "http://127.0.0.1:4321/callback",
              code_challenge,
              granted_doco_ids: [],
              granted_doco_roles: {},
              granted_doco_write_types: {},
              granted_workspace_ids: [],
              granted_workspace_roles: {},
              granted_workspace_write_types: {},
              grant_type: "actor",
              actor_role: "writer",
              scope: "doco",
              expires_at: new Date(Date.now() + 10_000_000),
              consumed_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const claim = await consumeAuthorizationCode({
      code: "doco_code_actor",
      client_id: "doco_client_browser",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_verifier: verifier,
    });
    expect(claim.grant_type).toBe("actor");
    expect(claim.actor_role).toBe("writer"); // the stored ceiling rides back out
    expect(claim.granted_doco_ids).toEqual([]);
  });

  it("approveDeviceAuthorization persists grant_type + actor_role (actor)", async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes("SELECT client_id")
        ? { rows: [{ client_id: "doco_client_device" }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    await approveDeviceAuthorization({
      device_code: "doco_dc_123",
      approver_user_id: "user_owner",
      granted_doco_ids: [],
      granted_workspace_ids: [],
      grant_type: "actor",
      actor_role: "writer",
    });
    const update = callsTo("UPDATE oauth_device_authorizations")[0]?.[1] as unknown[];
    expect(update[8]).toBe("actor"); // grant_type
    expect(update[9]).toBe("writer"); // actor_role ceiling, last in the SET list
  });

  it("pollDeviceAuthorization carries an actor grant_type into the minted refresh token", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("FROM oauth_device_authorizations") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              device_code: "doco_dc_123",
              user_code: "WXYZ-1234",
              client_id: "doco_client_device",
              scope: "doco",
              status: "approved",
              user_id: "user_owner",
              granted_doco_ids: [],
              granted_doco_roles: {},
              granted_doco_write_types: {},
              granted_workspace_ids: [],
              granted_workspace_roles: {},
              granted_workspace_write_types: {},
              grant_type: "actor",
              actor_role: "reader",
              target_doco_handle: null,
              requested_role: null,
              expires_at: new Date(Date.now() + 10_000_000),
              last_polled_at: null,
              created_at: new Date(),
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await pollDeviceAuthorization({
      device_code: "doco_dc_123",
      client_id: "doco_client_device",
    });
    expect(result.kind).toBe("approved");
    const refreshInsert = callsTo("INSERT INTO oauth_refresh_tokens")[0]?.[1] as unknown[];
    expect(refreshInsert[11]).toBe("actor"); // grant_type
    expect(refreshInsert[12]).toBe("reader"); // actor_role ceiling carried onto the refresh
  });
});

describe("token scope invariant (assertScopedGrant)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUlid.mockReturnValue("01AGENT0000000000000000000");
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (callback) => callback({ query: mocks.query }));
    mocks.withClient.mockImplementation(async (callback) => callback({ query: mocks.query }));
  });

  it("allows a token scoped to one workspace", () => {
    expect(() =>
      assertScopedGrant({ granted_doco_ids: [], granted_workspace_ids: ["workspace_a"] }),
    ).not.toThrow();
  });

  it("allows a token scoped to several workspaces", () => {
    expect(() =>
      assertScopedGrant({
        granted_doco_ids: [],
        granted_workspace_ids: ["workspace_a", "workspace_b"],
      }),
    ).not.toThrow();
  });

  it("allows Docos from different workspaces", () => {
    expect(() =>
      assertScopedGrant({ granted_doco_ids: ["doco_1", "doco_2"], granted_workspace_ids: [] }),
    ).not.toThrow();
  });

  it("rejects the legacy '*' (full-access) Doco grant", () => {
    expect(() => assertScopedGrant({ granted_doco_ids: ["*"], granted_workspace_ids: [] })).toThrow(
      /full-access/i,
    );
  });

  it("rejects a '*' workspace grant", () => {
    expect(() => assertScopedGrant({ granted_doco_ids: [], granted_workspace_ids: ["*"] })).toThrow(
      /full-access/i,
    );
  });

  it("issueAuthorizationCode accepts a grant spanning two workspaces", async () => {
    await issueAuthorizationCode({
      client_id: "doco_client_x",
      approver_user_id: "user_owner",
      redirect_uri: "http://127.0.0.1:4321/callback",
      code_challenge: "challenge",
      granted_doco_ids: ["doco_1"],
      granted_workspace_ids: ["workspace_a", "workspace_b"],
      scope: "doco",
    });
    expect(callsTo("INSERT INTO oauth_authorization_codes")).toHaveLength(1);
  });

  it("issueTokens rejects a '*' grant", async () => {
    await expect(
      issueTokens({
        client_id: "doco_client_x",
        user_id: "user_owner",
        granted_doco_ids: ["*"],
        scope: null,
      }),
    ).rejects.toThrow(/full-access/i);
    expect(callsTo("INSERT INTO oauth_access_tokens")).toHaveLength(0);
  });

  it("approveDeviceAuthorization rejects a '*' grant", async () => {
    await expect(
      approveDeviceAuthorization({
        device_code: "doco_dc_123",
        approver_user_id: "user_owner",
        granted_doco_ids: [],
        granted_workspace_ids: ["*"],
      }),
    ).rejects.toThrow(/full-access/i);
    expect(callsTo("UPDATE oauth_device_authorizations")).toHaveLength(0);
  });
});

describe("mergeGrantSets", () => {
  it("unions disjoint Doco and workspace grants", () => {
    const merged = mergeGrantSets(
      { ...emptyGrants, granted_doco_ids: ["a"], granted_doco_roles: { a: "reader" } },
      {
        ...emptyGrants,
        granted_doco_ids: ["b"],
        granted_doco_roles: { b: "writer" },
        granted_doco_write_types: { b: ["decision"] },
        granted_workspace_ids: ["workspace_x"],
        granted_workspace_roles: { workspace_x: "owner" },
      },
    );
    expect(merged.granted_doco_ids).toEqual(["a", "b"]);
    expect(merged.granted_doco_roles).toEqual({ a: "reader", b: "writer" });
    expect(merged.granted_doco_write_types).toEqual({ b: ["decision"] });
    expect(merged.granted_workspace_ids).toEqual(["workspace_x"]);
    expect(merged.granted_workspace_roles).toEqual({ workspace_x: "owner" });
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
        granted_workspace_ids: ["workspace_x"],
        granted_workspace_roles: { workspace_x: "writer" },
      },
      emptyGrants,
    );
    expect(merged.granted_workspace_ids).toEqual(["workspace_x"]);
    expect(merged.granted_workspace_roles.workspace_x).toBe("writer");
  });
});
