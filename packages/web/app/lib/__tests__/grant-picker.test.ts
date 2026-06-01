import { describe, expect, it } from "vitest";
import {
  type ComposedGrant,
  type ExistingGrant,
  type GrantCatalog,
  applyDocoTypeLevel,
  applyTargetRole,
  availableScopes,
  describeExistingGrant,
  describeWriteScope,
  effectiveTypeLevel,
  findGrant,
  grantKey,
  grantableRoles,
  inheritedTypeLevel,
  rank,
  removeGrant,
  resolveWriteTypes,
  scopeShowsPerTypeControls,
  selectionCount,
  setTypeLevel,
  targetRoleOptions,
  targetRoleValue,
  targetsByOrg,
  typeDropdownValue,
  upsertGrant,
  writableTypeGroups,
} from "../grant-picker";

const ALL = ["decision", "intent", "action"] as const;

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
    expect(g.edges).toContain("flows_to");
  });
});

describe("availableScopes", () => {
  it("offers account only when the user owns an org", () => {
    const scopes = availableScopes(catalog).map((s) => s.scope);
    // catalog: organization_A is owner → account offered; org + doco + types too.
    expect(scopes).toEqual(["account", "org", "doco", "types"]);
  });
  it("uses plural scope labels for broad targets", () => {
    expect(availableScopes(catalog).map((s) => s.title)).toEqual([
      "All your orgs and docos",
      "Specific organization(s)",
      "Specific docos",
      "Specific node or edge types",
    ]);
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
      targetId: "",
      label: "alice",
      role: "writer",
      writeTypes: ["*"],
    };
    const org: ExistingGrant = {
      level: "org",
      targetId: "organization_acme",
      label: "acme",
      role: "reader",
      writeTypes: ["decision"],
    };
    const doco: ExistingGrant = {
      level: "doco",
      targetId: "doco_api",
      label: "acme/api",
      role: "owner",
      writeTypes: [],
    };
    expect(describeExistingGrant(acct)).toBe("Entire account: alice — writes everything");
    expect(describeExistingGrant(org)).toBe("Org: acme — writes 1 type");
    expect(describeExistingGrant(doco)).toBe("Doco: acme/api — owns — writes everything");
  });
});

describe("per-type access levels", () => {
  describe("inheritedTypeLevel", () => {
    it("writer/owner/wildcard inherit write; reader inherits read", () => {
      expect(inheritedTypeLevel("writer", [])).toBe("write");
      expect(inheritedTypeLevel("owner", [])).toBe("write");
      expect(inheritedTypeLevel("reader", ["*"])).toBe("write");
      expect(inheritedTypeLevel("reader", [])).toBe("read");
      expect(inheritedTypeLevel("reader", ["decision"])).toBe("read");
    });
  });

  describe("effectiveTypeLevel", () => {
    it("a named type writes; others fall to inherited", () => {
      expect(effectiveTypeLevel("reader", ["decision"], "decision")).toBe("write");
      expect(effectiveTypeLevel("reader", ["decision"], "intent")).toBe("read");
    });
    it("writer writes everything regardless of set", () => {
      expect(effectiveTypeLevel("writer", [], "intent")).toBe("write");
    });
  });

  describe("typeDropdownValue", () => {
    it("shows 'default' when a type matches its inherited level", () => {
      // reader base → inherited read; an un-named type reads → default.
      expect(typeDropdownValue("reader", ["decision"], "intent")).toBe("default");
      // the named write override differs from inherited read → explicit write.
      expect(typeDropdownValue("reader", ["decision"], "decision")).toBe("write");
    });
    it("a reader-base type forced to read under a writer base shows explicit read", () => {
      // writer base → inherited write; a type NOT in the (sparse) set still
      // inherits write because writer writes everything, so it reads default.
      expect(typeDropdownValue("writer", [], "decision")).toBe("default");
    });
  });

  describe("setTypeLevel", () => {
    it("override one type to write from a reader baseline", () => {
      const next = setTypeLevel("reader", [], "decision", "write", ALL);
      expect(next).toEqual(["decision"]);
    });
    it("override back to default drops the explicit entry", () => {
      const next = setTypeLevel("reader", ["decision"], "decision", "default", ALL);
      expect(next).toEqual([]);
    });
    it("setting every type to write collapses to the wildcard", () => {
      let wt: string[] = [];
      for (const t of ALL) wt = setTypeLevel("reader", wt, t, "write", ALL);
      expect(wt).toEqual(["*"]);
    });
    it("editing one type preserves the others", () => {
      const start = setTypeLevel("reader", [], "decision", "write", ALL); // ["decision"]
      const next = setTypeLevel("reader", start, "intent", "write", ALL);
      expect(new Set(next)).toEqual(new Set(["decision", "intent"]));
    });
    it("from a writer baseline, setting one type to read narrows to the rest", () => {
      // writer inherits write on all; read on 'action' → write set = the other two.
      const next = setTypeLevel("writer", ["*"], "action", "read", ALL);
      expect(new Set(next)).toEqual(new Set(["decision", "intent"]));
    });
  });
});

describe("scopeShowsPerTypeControls", () => {
  it("ONLY the types scope shows per-type controls", () => {
    expect(scopeShowsPerTypeControls("types")).toBe(true);
    expect(scopeShowsPerTypeControls("account")).toBe(false);
    expect(scopeShowsPerTypeControls("org")).toBe(false);
    expect(scopeShowsPerTypeControls("doco")).toBe(false);
  });
});

describe("multi-grant selection", () => {
  it("upsert/find/remove by (level,targetId)", () => {
    let list: ComposedGrant[] = [];
    list = upsertGrant(list, { level: "org", targetId: "o1", role: "reader", writeTypes: [] });
    list = upsertGrant(list, { level: "org", targetId: "o2", role: "writer", writeTypes: ["*"] });
    expect(list).toHaveLength(2);
    // upsert same key replaces, doesn't duplicate
    list = upsertGrant(list, { level: "org", targetId: "o1", role: "owner", writeTypes: [] });
    expect(list).toHaveLength(2);
    expect(findGrant(list, "org", "o1")?.role).toBe("owner");
    list = removeGrant(list, "org", "o1");
    expect(findGrant(list, "org", "o1")).toBeUndefined();
    expect(list).toHaveLength(1);
  });

  it("targetRoleOptions caps at the granter's role and always offers 'none'", () => {
    expect(targetRoleOptions("writer")).toEqual(["none", "reader", "writer"]);
    expect(targetRoleOptions("reader")).toEqual(["none", "reader"]);
  });

  it("applyTargetRole adds, switches, and removes org grants", () => {
    let list: ComposedGrant[] = [];
    list = applyTargetRole(list, "org", "o1", "writer");
    expect(findGrant(list, "org", "o1")).toEqual({
      level: "org",
      targetId: "o1",
      role: "writer",
      writeTypes: ["*"],
    });
    list = applyTargetRole(list, "org", "o1", "reader");
    expect(findGrant(list, "org", "o1")?.writeTypes).toEqual([]);
    list = applyTargetRole(list, "org", "o1", "none");
    expect(findGrant(list, "org", "o1")).toBeUndefined();
  });

  it("targetRoleValue reflects the current selection ('none' when absent)", () => {
    const list = applyTargetRole([], "doco", "d1", "reader");
    expect(targetRoleValue(list, "doco", "d1")).toBe("reader");
    expect(targetRoleValue(list, "doco", "d9")).toBe("none");
  });

  it("targetRoleValue falls back to existing access until the user changes it", () => {
    const existing: ExistingGrant[] = [
      {
        level: "doco",
        targetId: "d1",
        label: "acme/runbook",
        role: "owner",
        writeTypes: [],
      },
    ];

    expect(targetRoleValue([], "doco", "d1", existing)).toBe("owner");

    const changed = applyTargetRole([], "doco", "d1", "reader");
    expect(targetRoleValue(changed, "doco", "d1", existing)).toBe("reader");
  });

  it("applyDocoTypeLevel builds a per-type doco grant and drops it when empty", () => {
    const ALLT = ["decision", "intent"] as const;
    let list: ComposedGrant[] = [];
    list = applyDocoTypeLevel(list, "d1", "decision", "write", ALLT);
    expect(findGrant(list, "doco", "d1")).toEqual({
      level: "doco",
      targetId: "d1",
      role: "reader",
      writeTypes: ["decision"],
    });
    // add the other type → wildcard collapse
    list = applyDocoTypeLevel(list, "d1", "intent", "write", ALLT);
    expect(findGrant(list, "doco", "d1")?.writeTypes).toEqual(["*"]);
    // back both to read → grant removed (nothing to grant)
    list = applyDocoTypeLevel(list, "d1", "decision", "read", ALLT);
    list = applyDocoTypeLevel(list, "d1", "intent", "read", ALLT);
    expect(findGrant(list, "doco", "d1")).toBeUndefined();
  });

  it("selectionCount counts grants", () => {
    let list: ComposedGrant[] = [];
    expect(selectionCount(list)).toBe(0);
    list = applyTargetRole(list, "org", "o1", "reader");
    list = applyTargetRole(list, "org", "o2", "owner");
    expect(selectionCount(list)).toBe(2);
  });
});
