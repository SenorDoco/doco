import { describe, expect, it } from "vitest";
import {
  type ComposedGrant,
  type ExistingGrant,
  type GrantCatalog,
  applyDocoTypeLevel,
  applyTargetRole,
  availableScopes,
  catalogFromOptions,
  coerceSingleWorkspace,
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
  targetsByWorkspace,
  typeDropdownValue,
  upsertGrant,
  writableTypeGroups,
} from "../grant-picker";

const ALL = ["decision", "intent", "action"] as const;

const catalog: GrantCatalog = {
  workspaces: [
    { id: "workspace_A", label: "acme" },
    { id: "workspace_B", label: "beta" },
  ],
  targets: [
    {
      level: "workspace",
      id: "workspace_A",
      workspaceId: "workspace_A",
      label: "acme",
      maxRole: "owner",
    },
    {
      level: "doco",
      id: "doco_1",
      workspaceId: "workspace_A",
      label: "acme/spec",
      maxRole: "owner",
    },
    {
      level: "doco",
      id: "doco_2",
      workspaceId: "workspace_A",
      label: "acme/api",
      maxRole: "writer",
    },
    { level: "doco", id: "doco_3", workspaceId: "workspace_B", label: "beta/x", maxRole: "reader" },
  ],
};

describe("targetsByWorkspace", () => {
  it("groups docos under their workspace and surfaces the workspace target", () => {
    const groups = targetsByWorkspace(catalog);
    expect(groups).toHaveLength(2);
    const acme = groups[0];
    expect(acme.workspace.label).toBe("acme");
    expect(acme.workspaceTarget?.id).toBe("workspace_A");
    expect(acme.docos.map((d) => d.id)).toEqual(["doco_2", "doco_1"]); // sorted by label: api, spec
  });
  it("an workspace with no workspace-level target still lists its docos", () => {
    const beta = targetsByWorkspace(catalog)[1];
    expect(beta.workspaceTarget).toBeNull();
    expect(beta.docos.map((d) => d.id)).toEqual(["doco_3"]);
  });
});

describe("catalogFromOptions", () => {
  it("buckets personally-owned docos under 'Personal / other'", () => {
    const catalog = catalogFromOptions([], [{ id: "doco_p", label: "p", maxRole: "owner" }]);
    const groups = targetsByWorkspace(catalog).filter((g) => g.docos.length > 0);
    expect(groups).toHaveLength(1);
    expect(groups[0].workspace.label).toBe("Personal / other");
    expect(groups[0].docos.map((d) => d.id)).toEqual(["doco_p"]);
  });

  // Regression: a Doco you own (owner role) that lives under an workspace you do
  // NOT own must still be grantable. The owner-only device/OAuth approve
  // screens pass such Docos (direct doco_users owner grant) while leaving
  // the workspace out of the workspaces list (you're not the workspace's owner). Before the
  // fix, catalogFromOptions only invented a bucket for the personal
  // sentinel, so these Docos were orphaned: the "Specific docos" scope
  // button appeared but the workspace drill-down showed "No docos you can grant".
  it("keeps a doco grantable when its owning workspace is not in the workspaces list", () => {
    const catalog = catalogFromOptions(
      [], // the granter owns no workspaces
      [
        {
          id: "doco_x",
          label: "bpms",
          maxRole: "owner",
          workspaceId: "workspace_unowned",
          workspaceLabel: "acme",
        },
      ],
    );
    const groups = targetsByWorkspace(catalog).filter((g) => g.docos.length > 0);
    expect(groups).toHaveLength(1);
    expect(groups[0].workspace.id).toBe("workspace_unowned");
    expect(groups[0].workspace.label).toBe("acme");
    expect(groups[0].docos.map((d) => d.id)).toEqual(["doco_x"]);
    // and the doco scope stays offered (it always was — that was the bug's tell)
    expect(availableScopes(catalog).map((s) => s.scope)).toContain("doco");
  });

  it("falls back to a generic workspace-bucket label when the workspace name is unknown", () => {
    const catalog = catalogFromOptions(
      [],
      [{ id: "doco_x", label: "bpms", maxRole: "owner", workspaceId: "workspace_unowned" }],
    );
    const groups = targetsByWorkspace(catalog).filter((g) => g.docos.length > 0);
    expect(groups).toHaveLength(1);
    expect(groups[0].workspace.label).toBe("Other workspace");
    expect(groups[0].docos.map((d) => d.id)).toEqual(["doco_x"]);
  });

  it("groups a doco under its workspace when the workspace IS in the list (no duplicate bucket)", () => {
    const catalog = catalogFromOptions(
      [{ id: "workspace_A", label: "acme", maxRole: "owner" }],
      [
        {
          id: "doco_1",
          label: "spec",
          maxRole: "owner",
          workspaceId: "workspace_A",
          workspaceLabel: "acme",
        },
      ],
    );
    const withDocos = targetsByWorkspace(catalog).filter((g) => g.docos.length > 0);
    expect(withDocos).toHaveLength(1);
    expect(withDocos[0].workspace.id).toBe("workspace_A");
    // the workspace-level grant target is preserved (owner can grant the whole workspace)
    expect(withDocos[0].workspaceTarget?.id).toBe("workspace_A");
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
  it("offers account only when the user owns an workspace", () => {
    const scopes = availableScopes(catalog).map((s) => s.scope);
    // catalog: workspace_A is owner → account offered; workspace + doco + types too.
    expect(scopes).toEqual(["account", "workspace", "doco", "types"]);
  });
  it("uses plural scope labels for broad targets", () => {
    expect(availableScopes(catalog).map((s) => s.title)).toEqual([
      "All your workspaces and docos",
      "Specific workspace(s)",
      "Specific docos",
      "Specific node or edge types",
    ]);
  });
  it("omits account when the user owns no workspace", () => {
    const noOwner: GrantCatalog = {
      workspaces: [{ id: "workspace_X", label: "x" }],
      targets: [
        {
          level: "workspace",
          id: "workspace_X",
          workspaceId: "workspace_X",
          label: "x",
          maxRole: "writer",
        },
        {
          level: "doco",
          id: "doco_9",
          workspaceId: "workspace_X",
          label: "x/d",
          maxRole: "writer",
        },
      ],
    };
    expect(availableScopes(noOwner).map((s) => s.scope)).toEqual(["workspace", "doco", "types"]);
  });
  it("offers nothing when there are no targets", () => {
    expect(availableScopes({ workspaces: [], targets: [] })).toEqual([]);
  });
  it("withholds the account scope when minting a token (single-workspace cap)", () => {
    // A token can never reach every workspace, so the account scope is dropped
    // even for a workspace owner; workspace/doco/types remain.
    expect(availableScopes(catalog, { forToken: true }).map((s) => s.scope)).toEqual([
      "workspace",
      "doco",
      "types",
    ]);
  });
});

describe("coerceSingleWorkspace (token one-workspace cap)", () => {
  const catalog: GrantCatalog = {
    workspaces: [
      { id: "workspace_A", label: "A" },
      { id: "workspace_B", label: "B" },
    ],
    targets: [
      { level: "workspace", id: "workspace_A", workspaceId: "workspace_A", label: "A", maxRole: "owner" },
      { level: "workspace", id: "workspace_B", workspaceId: "workspace_B", label: "B", maxRole: "owner" },
      { level: "doco", id: "doco_a1", workspaceId: "workspace_A", label: "A/1", maxRole: "owner" },
      { level: "doco", id: "doco_b1", workspaceId: "workspace_B", label: "B/1", maxRole: "owner" },
      { level: "doco", id: "doco_personal", workspaceId: "__other__", label: "me/p", maxRole: "owner" },
    ],
  };
  const g = (level: "workspace" | "doco", targetId: string): ComposedGrant => ({
    level,
    targetId,
    role: "reader",
    writeTypes: [],
  });

  it("keeps a single workspace's grants unchanged", () => {
    const next = [g("workspace", "workspace_A"), g("doco", "doco_a1")];
    expect(coerceSingleWorkspace([], next, catalog)).toEqual(next);
  });

  it("drops earlier-workspace grants when a second workspace is added", () => {
    const prev = [g("doco", "doco_a1")];
    const next = [g("doco", "doco_a1"), g("doco", "doco_b1")];
    // The just-added doco_b1 wins; doco_a1 (workspace_A) is dropped.
    expect(coerceSingleWorkspace(prev, next, catalog)).toEqual([g("doco", "doco_b1")]);
  });

  it("treats personal Docos as workspace-less (they never force a drop)", () => {
    const prev = [g("doco", "doco_personal")];
    const next = [g("doco", "doco_personal"), g("workspace", "workspace_A")];
    expect(coerceSingleWorkspace(prev, next, catalog)).toEqual(next);
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
    const workspace: ExistingGrant = {
      level: "workspace",
      targetId: "workspace_acme",
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
    expect(describeExistingGrant(workspace)).toBe("Workspace: acme — writes 1 type");
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
    expect(scopeShowsPerTypeControls("workspace")).toBe(false);
    expect(scopeShowsPerTypeControls("doco")).toBe(false);
  });
});

describe("multi-grant selection", () => {
  it("upsert/find/remove by (level,targetId)", () => {
    let list: ComposedGrant[] = [];
    list = upsertGrant(list, {
      level: "workspace",
      targetId: "o1",
      role: "reader",
      writeTypes: [],
    });
    list = upsertGrant(list, {
      level: "workspace",
      targetId: "o2",
      role: "writer",
      writeTypes: ["*"],
    });
    expect(list).toHaveLength(2);
    // upsert same key replaces, doesn't duplicate
    list = upsertGrant(list, { level: "workspace", targetId: "o1", role: "owner", writeTypes: [] });
    expect(list).toHaveLength(2);
    expect(findGrant(list, "workspace", "o1")?.role).toBe("owner");
    list = removeGrant(list, "workspace", "o1");
    expect(findGrant(list, "workspace", "o1")).toBeUndefined();
    expect(list).toHaveLength(1);
  });

  it("targetRoleOptions caps at the granter's role and always offers 'none'", () => {
    expect(targetRoleOptions("writer")).toEqual(["none", "reader", "writer"]);
    expect(targetRoleOptions("reader")).toEqual(["none", "reader"]);
  });

  it("applyTargetRole adds, switches, and removes workspace grants", () => {
    let list: ComposedGrant[] = [];
    list = applyTargetRole(list, "workspace", "o1", "writer");
    expect(findGrant(list, "workspace", "o1")).toEqual({
      level: "workspace",
      targetId: "o1",
      role: "writer",
      writeTypes: ["*"],
    });
    list = applyTargetRole(list, "workspace", "o1", "reader");
    expect(findGrant(list, "workspace", "o1")?.writeTypes).toEqual([]);
    list = applyTargetRole(list, "workspace", "o1", "none");
    expect(findGrant(list, "workspace", "o1")).toBeUndefined();
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
    list = applyTargetRole(list, "workspace", "o1", "reader");
    list = applyTargetRole(list, "workspace", "o2", "owner");
    expect(selectionCount(list)).toBe(2);
  });
});
