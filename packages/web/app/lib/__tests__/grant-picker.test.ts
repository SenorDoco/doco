import { describe, expect, it } from "vitest";
import {
  type ExistingGrant,
  type GrantCatalog,
  availableScopes,
  describeExistingGrant,
  describeWriteScope,
  grantableRoles,
  rank,
  resolveWriteTypes,
  targetsByOrg,
  writableTypeGroups,
} from "../grant-picker";

const catalog: GrantCatalog = {
  orgs: [
    { id: "organization_A", label: "acme" },
    { id: "organization_B", label: "beta" },
  ],
  targets: [
    {
      level: "org",
      id: "organization_A",
      orgId: "organization_A",
      label: "acme",
      maxRole: "owner",
    },
    { level: "doco", id: "doco_1", orgId: "organization_A", label: "acme/spec", maxRole: "owner" },
    { level: "doco", id: "doco_2", orgId: "organization_A", label: "acme/api", maxRole: "writer" },
    { level: "doco", id: "doco_3", orgId: "organization_B", label: "beta/x", maxRole: "reader" },
  ],
};

describe("targetsByOrg", () => {
  it("groups docos under their org and surfaces the org target", () => {
    const groups = targetsByOrg(catalog);
    expect(groups).toHaveLength(2);
    const acme = groups[0];
    expect(acme.org.label).toBe("acme");
    expect(acme.orgTarget?.id).toBe("organization_A");
    expect(acme.docos.map((d) => d.id)).toEqual(["doco_2", "doco_1"]); // sorted by label: api, spec
  });
  it("an org with no org-level target still lists its docos", () => {
    const beta = targetsByOrg(catalog)[1];
    expect(beta.orgTarget).toBeNull();
    expect(beta.docos.map((d) => d.id)).toEqual(["doco_3"]);
  });
});

describe("grantableRoles", () => {
  it("caps at the user's own role", () => {
    expect(grantableRoles("owner")).toEqual(["reader", "writer", "owner"]);
    expect(grantableRoles("writer")).toEqual(["reader", "writer"]);
    expect(grantableRoles("reader")).toEqual(["reader"]);
  });
});

describe("rank", () => {
  it("orders the roles", () => {
    expect(rank("owner")).toBeGreaterThan(rank("writer"));
    expect(rank("writer")).toBeGreaterThan(rank("reader"));
  });
});

describe("resolveWriteTypes", () => {
  it("owner persists no per-type set", () => {
    expect(resolveWriteTypes("owner", ["decision"])).toEqual([]);
  });
  it("reader keeps the normalized subset", () => {
    expect(resolveWriteTypes("reader", ["decision", "junk", "decision"])).toEqual(["decision"]);
  });
  it("wildcard collapses", () => {
    expect(resolveWriteTypes("writer", ["decision", "*"])).toEqual(["*"]);
  });
  it("reader with no types is read-only", () => {
    expect(resolveWriteTypes("reader", [])).toEqual([]);
  });
});

describe("describeWriteScope", () => {
  it("summarizes each shape", () => {
    expect(describeWriteScope("owner", [])).toMatch(/owns/);
    expect(describeWriteScope("reader", [])).toBe("read only");
    expect(describeWriteScope("reader", ["*"])).toBe("writes everything");
    expect(describeWriteScope("reader", ["decision"])).toBe("writes 1 type");
    expect(describeWriteScope("reader", ["decision", "intent"])).toBe("writes 2 types");
  });
});

describe("writableTypeGroups", () => {
  it("exposes both node and edge lists", () => {
    const g = writableTypeGroups();
    expect(g.nodes).toContain("decision");
    expect(g.edges).toContain("sequence_flow");
  });
});

describe("availableScopes", () => {
  it("offers account only when the user owns an org", () => {
    const scopes = availableScopes(catalog).map((s) => s.scope);
    // catalog: organization_A is owner → account offered; org + doco + types too.
    expect(scopes).toEqual(["account", "org", "doco", "types"]);
  });
  it("omits account when the user owns no org", () => {
    const noOwner: GrantCatalog = {
      orgs: [{ id: "organization_X", label: "x" }],
      targets: [
        {
          level: "org",
          id: "organization_X",
          orgId: "organization_X",
          label: "x",
          maxRole: "writer",
        },
        { level: "doco", id: "doco_9", orgId: "organization_X", label: "x/d", maxRole: "writer" },
      ],
    };
    expect(availableScopes(noOwner).map((s) => s.scope)).toEqual(["org", "doco", "types"]);
  });
  it("offers nothing when there are no targets", () => {
    expect(availableScopes({ orgs: [], targets: [] })).toEqual([]);
  });
});

describe("describeExistingGrant", () => {
  it("summarizes each level", () => {
    const acct: ExistingGrant = {
      level: "account",
      label: "alice",
      role: "writer",
      writeTypes: ["*"],
    };
    const org: ExistingGrant = {
      level: "org",
      label: "acme",
      role: "reader",
      writeTypes: ["decision"],
    };
    const doco: ExistingGrant = { level: "doco", label: "acme/api", role: "owner", writeTypes: [] };
    expect(describeExistingGrant(acct)).toBe("Entire account: alice — writes everything");
    expect(describeExistingGrant(org)).toBe("Org: acme — writes 1 type");
    expect(describeExistingGrant(doco)).toBe("Doco: acme/api — owns — writes everything");
  });
});
