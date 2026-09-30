import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserByGithubLogin: vi.fn(),
  query: vi.fn(),
  setSessionCookie: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getUserByGithubLogin: mocks.getUserByGithubLogin,
  withClient: mocks.withClient,
}));

vi.mock("~/lib/session.server", () => ({
  setSessionCookie: mocks.setSessionCookie,
}));

import { action } from "../auth.dev-signin";

const TEST_USER = {
  id: "user_01KCV4D0M5R4PF6ET9TRQMEQ3K",
  github_id: null,
  github_login: "doco-test-harness",
  email: null,
  avatar_url: null,
  data: {},
};

function request(username = "doco-test-harness"): Request {
  const body = new URLSearchParams({ username, next: "/workspaces" });
  return new Request("https://doco.test/auth/dev-signin", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("/auth/dev-signin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let lookupCount = 0;
    mocks.getUserByGithubLogin.mockImplementation(async () => {
      lookupCount += 1;
      return lookupCount === 1 ? null : TEST_USER;
    });
    mocks.setSessionCookie.mockReturnValue("doco_session=test; Path=/");
    mocks.withClient.mockImplementation((callback) => callback({ query: mocks.query }));
  });

  it("sets users.kind when the production table requires it", async () => {
    let insertSql = "";
    let insertParams: unknown[] = [];
    mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ has_kind_column: true }] };
      }
      if (sql.includes("INSERT INTO users")) {
        insertSql = sql;
        insertParams = params;
      }
      return { rows: [] };
    });

    const response = await action({ request: request() });

    expect(response.status).toBe(302);
    expect(response.headers.get("Set-Cookie")).toBe("doco_session=test; Path=/");
    expect(insertSql).toContain("(id, kind, github_login, data)");
    expect(insertParams).toEqual([
      expect.stringMatching(/^user_[0-9A-HJKMNP-TV-Z]{26}$/),
      "person",
      "doco-test-harness",
      expect.stringContaining("Lazy-created by /auth/dev-signin"),
    ]);
  });

  it("keeps the legacy insert for local schemas without users.kind", async () => {
    let insertSql = "";
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return { rows: [{ has_kind_column: false }] };
      }
      if (sql.includes("INSERT INTO users")) {
        insertSql = sql;
      }
      return { rows: [] };
    });

    const response = await action({ request: request() });

    expect(response.status).toBe(302);
    expect(insertSql).toContain("(id, github_login, data)");
    expect(insertSql).not.toContain("(id, kind, github_login, data)");
  });
});
