import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withClient: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: mocks.withClient,
}));

import {
  ensureDefaultsAttached,
  listPerspectivesForDoco,
  resolveActivePerspective,
} from "../perspectives.server";

describe("perspectives.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withClient.mockImplementation((fn) => fn({ query: mocks.query }));
  });

  it("lists attached perspectives in stored tab position order", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "perspective_graph",
          slug: "graph",
          kind: "graph",
          name: "Graph",
          description: null,
          icon: null,
          owner_handle: null,
          is_builtin: true,
          config: {},
          position: 0,
          is_default: false,
        },
        {
          id: "perspective_list",
          slug: "list",
          kind: "list",
          name: "List",
          description: null,
          icon: null,
          owner_handle: null,
          is_builtin: true,
          config: {},
          position: 1,
          is_default: false,
        },
        {
          id: "perspective_org_tree",
          slug: "org-tree",
          kind: "org-tree",
          name: "Org Tree",
          description: null,
          icon: null,
          owner_handle: null,
          is_builtin: true,
          config: {},
          position: 2,
          is_default: true,
        },
      ],
    });

    const perspectives = await listPerspectivesForDoco("doco_acme");

    expect(mocks.query.mock.calls[0]?.[0]).toMatch(/ORDER BY dp\.position ASC/i);
    expect(perspectives.map((p) => p.slug)).toEqual(["graph", "list", "org-tree"]);
  });

  it("resolves the default perspective even when it is not first in tab order", () => {
    const active = resolveActivePerspective(
      [
        {
          id: "perspective_graph",
          slug: "graph",
          kind: "graph",
          name: "Graph",
          description: null,
          icon: null,
          ownerHandle: null,
          isBuiltin: true,
          config: {},
          position: 0,
          isDefault: false,
        },
        {
          id: "perspective_org_tree",
          slug: "org-tree",
          kind: "org-tree",
          name: "Org Tree",
          description: null,
          icon: null,
          ownerHandle: null,
          isBuiltin: true,
          config: {},
          position: 2,
          isDefault: true,
        },
      ],
      null,
    );

    expect(active?.slug).toBe("org-tree");
  });

  it("attaches graph and list when a Doco has no perspectives yet", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ n: "0" }] });
    mocks.query.mockResolvedValue({ rows: [] });

    await ensureDefaultsAttached("doco_acme");

    const inserts = mocks.query.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => /INSERT INTO doco_perspectives/i.test(sql));

    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toContain("'perspective_graph'");
    expect(inserts[1]).toContain("'perspective_list'");
  });
});
