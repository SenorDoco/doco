import { describe, expect, it } from "vitest";
import {
  type ComposedGrant,
  type ExistingGrant,
  type GrantCatalog,
  actorGrant,
  applyTargetRole,
  availableScopes,
  catalogFromOptions,
  describeExistingGrant,
  describeWriteScope,
  findGrant,
  grantKey,
  grantableRoles,
  rank,
  removeGrant,
  resolveWriteTypes,
  selectionCount,
  targetRoleOptions,
  targetRoleValue,
  targetsByWorkspace,
  upsertGrant,
} from "../grant-picker";

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

describe("availableScopes", () => {
  it("never offers an account scope when granting a person — only concrete targets", () => {
    // "All your workspaces" is a token-only authorization now; a person is
    // granted specific workspaces/docos, never a whole-account delegation.
    const scopes = availableScopes(catalog).map((s) => s.scope);
    expect(scopes).not.toContain("account");
    expect(scopes).toEqual(["workspace", "doco"]);
  });
  it("uses plural scope labels for broad targets", () => {
    expect(availableScopes(catalog).map((s) => s.title)).toEqual([
      "Specific workspace(s)",
      "Specific docos",
    ]);
  });
  it("never offers a per-node-or-edge-type scope", () => {
    const titles = availableScopes(catalog, { offerActor: true }).map((s) => s.title);
    expect(titles).not.toContain("Specific node or edge types");
  });
  it("offers the same concrete scopes when the user owns no workspace", () => {
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
    expect(availableScopes(noOwner).map((s) => s.scope)).toEqual(["workspace", "doco"]);
  });
  it("offers nothing when there are no targets", () => {
    expect(availableScopes({ workspaces: [], targets: [] })).toEqual([]);
  });
  it("leads the token consent with the actor scope when the host opts in", () => {
    // The actor ("all workspaces") credential is the breadth option: it reaches
    // every workspace the user belongs to, now and later. It leads, then
    // workspace/doco.
    expect(availableScopes(catalog, { offerActor: true }).map((s) => s.scope)).toEqual([
      "actor",
      "workspace",
      "doco",
    ]);
  });
  it("never offers the actor scope unless the host opts in (e.g. the /tokens radio)", () => {
    // The /tokens page drives actor from its own toggle and leaves offerActor off.
    expect(availableScopes(catalog).map((s) => s.scope)).not.toContain("actor");
  });
  it("withholds the actor scope from a bound (per-workspace) connector", () => {
    // A connector pinned to one workspace can't mint an all-workspaces token.
    const scopes = availableScopes(catalog, { offerActor: true, boundWorkspaceLabel: "acme" });
    expect(scopes.map((s) => s.scope)).not.toContain("actor");
  });
  it("withholds the actor scope when there's no workspace to act in", () => {
    // Only a personal Doco, no workspace membership → nothing for an actor
    // token to reach, so it isn't offered even with offerActor.
    const personalOnly: GrantCatalog = {
      workspaces: [{ id: "__other__", label: "Personal / other" }],
      targets: [
        {
          level: "doco",
          id: "doco_personal",
          workspaceId: "__other__",
          label: "my-notes",
          maxRole: "owner",
        },
      ],
    };
    expect(availableScopes(personalOnly, { offerActor: true }).map((s) => s.scope)).not.toContain(
      "actor",
    );
  });
  it("names the workspace scope after the bound workspace, dropping the plural label", () => {
    const scopes = availableScopes(catalog, { boundWorkspaceLabel: "torre" });
    expect(scopes.find((s) => s.scope === "workspace")?.title).toBe("The entire torre workspace");
    expect(scopes.map((s) => s.title)).not.toContain("Specific workspace(s)");
  });
});

describe("actor grant (all-your-workspaces token)", () => {
  it("composes a target-less grant defaulting to the owner (full-role) ceiling", () => {
    expect(actorGrant()).toEqual({ level: "actor", targetId: "", role: "owner", writeTypes: [] });
  });
  it("carries the chosen role as the ceiling", () => {
    expect(actorGrant("reader").role).toBe("reader");
    expect(actorGrant("writer").role).toBe("writer");
  });
});

describe("describeExistingGrant", () => {
  it("summarizes each level", () => {
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
    expect(describeExistingGrant(workspace)).toBe("Workspace: acme — writes 1 type");
    expect(describeExistingGrant(doco)).toBe("Doco: acme/api — owns — writes everything");
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

  it("selectionCount counts grants", () => {
    let list: ComposedGrant[] = [];
    expect(selectionCount(list)).toBe(0);
    list = applyTargetRole(list, "workspace", "o1", "reader");
    list = applyTargetRole(list, "workspace", "o2", "owner");
    expect(selectionCount(list)).toBe(2);
  });
});
