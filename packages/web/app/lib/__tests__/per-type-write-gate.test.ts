import { canWriteType, normalizeWriteTypes } from "@doco/shared";
import { describe, expect, it } from "vitest";

// Engine-level semantics for the per-type write gate
// (decision_per_type_write_grants). getDocoLevelGrant / canWriteDocoType
// are DB-bound (covered by integration tests); here we lock the pure
// combination rules the gate relies on, including the token-cap AND-ing.

// Mirror of doco-access.server.ts#tokenWriteTypeCap for unit coverage of
// the token-cap AND-ing rules without a live request/token.
function tokenCap(
  meta: { ownerId: string; docoId?: string },
  token: {
    granted_doco_ids: string[];
    granted_doco_roles: Record<string, string>;
    granted_doco_write_types: Record<string, string[]>;
    granted_org_ids: string[];
    granted_org_roles: Record<string, string>;
    granted_org_write_types: Record<string, string[]>;
  } | null,
): string[] | null {
  if (!token) return null;
  const caps = new Set<string>();
  let matched = false;
  if (meta.docoId && token.granted_doco_ids.includes(meta.docoId)) {
    matched = true;
    const wt = token.granted_doco_write_types[meta.docoId];
    if (wt) for (const t of normalizeWriteTypes(wt)) caps.add(t);
    if (
      !wt?.length &&
      (token.granted_doco_roles[meta.docoId] === "owner" ||
        token.granted_doco_roles[meta.docoId] === "writer")
    ) {
      caps.add("*");
    }
  }
  if (meta.ownerId.startsWith("organization_") && token.granted_org_ids.includes(meta.ownerId)) {
    matched = true;
    const wt = token.granted_org_write_types[meta.ownerId];
    if (wt) for (const t of normalizeWriteTypes(wt)) caps.add(t);
    if (
      !wt?.length &&
      (token.granted_org_roles[meta.ownerId] === "owner" ||
        token.granted_org_roles[meta.ownerId] === "writer")
    ) {
      caps.add("*");
    }
  }
  if (!matched) return [];
  return normalizeWriteTypes([...caps]);
}

const emptyToken = {
  granted_doco_ids: [],
  granted_doco_roles: {},
  granted_doco_write_types: {},
  granted_org_ids: [],
  granted_org_roles: {},
  granted_org_write_types: {},
};

describe("per-type write gate — membership semantics", () => {
  it("owner writes any type", () => {
    expect(canWriteType("owner", [], "decision")).toBe(true);
  });
  it("reader with a named grant writes only that type", () => {
    expect(canWriteType("reader", ["decision"], "decision")).toBe(true);
    expect(canWriteType("reader", ["decision"], "action")).toBe(false);
  });
  it("wildcard membership writes everything", () => {
    expect(canWriteType("reader", ["*"], "flows_to")).toBe(true);
  });
});

describe("per-type write gate — token cap AND-ing", () => {
  const orgDoco = { ownerId: "organization_A", docoId: "doco_1" };

  it("no token → null cap (cookie session, no scope-down)", () => {
    expect(tokenCap(orgDoco, null)).toBeNull();
  });

  it("token not scoped to the target → empty cap (writes nothing)", () => {
    expect(tokenCap(orgDoco, { ...emptyToken })).toEqual([]);
  });

  it("writer-role token without a per-type map writes everything", () => {
    const cap = tokenCap(orgDoco, {
      ...emptyToken,
      granted_doco_ids: ["doco_1"],
      granted_doco_roles: { doco_1: "writer" },
    });
    expect(cap).toEqual(["*"]);
    expect(canWriteType("reader", cap, "principal")).toBe(true);
  });

  it("writer-role token with an empty per-type map still writes everything", () => {
    const cap = tokenCap(orgDoco, {
      ...emptyToken,
      granted_doco_ids: ["doco_1"],
      granted_doco_roles: { doco_1: "writer" },
      granted_doco_write_types: { doco_1: [] },
    });
    expect(cap).toEqual(["*"]);
    expect(canWriteType("reader", cap, "principal")).toBe(true);
  });

  it("owner-role token (no per-type map) → wildcard cap", () => {
    const cap = tokenCap(orgDoco, {
      ...emptyToken,
      granted_doco_ids: ["doco_1"],
      granted_doco_roles: { doco_1: "owner" },
    });
    expect(cap).toEqual(["*"]);
    expect(canWriteType("reader", cap, "idea")).toBe(true);
  });

  it("per-type token caps to exactly its granted types", () => {
    const cap = tokenCap(orgDoco, {
      ...emptyToken,
      granted_doco_ids: ["doco_1"],
      granted_doco_write_types: { doco_1: ["decision"] },
    });
    expect(cap).toEqual(["decision"]);
    // AND-ing: even if membership allowed 'action', the token cap blocks it.
    expect(canWriteType("reader", cap, "action")).toBe(false);
    expect(canWriteType("reader", cap, "decision")).toBe(true);
  });

  it("org-scoped per-type cap unions across doco and org grants", () => {
    const cap = tokenCap(orgDoco, {
      ...emptyToken,
      granted_doco_ids: ["doco_1"],
      granted_doco_write_types: { doco_1: ["decision"] },
      granted_org_ids: ["organization_A"],
      granted_org_write_types: { organization_A: ["intent"] },
    });
    expect(new Set(cap)).toEqual(new Set(["decision", "intent"]));
  });
});

// Account grants fold into the doco-level grant exactly like every
// other source: the engine takes the MAX role and the UNION of write-type
// sets across direct/org/account/doco grants (owner ⇒ wildcard).
// This mirrors getDocoLevelGrant#fold without a live DB.
type Grant = { role: "owner" | "writer" | "reader"; writeTypes: string[] };
function foldGrants(sources: (Grant | null)[]): Grant | null {
  let role: "owner" | "writer" | "reader" | null = null;
  const wt = new Set<string>();
  const rank = (r: "owner" | "writer" | "reader") => (r === "owner" ? 2 : r === "writer" ? 1 : 0);
  for (const g of sources) {
    if (!g) continue;
    if (role === null || rank(g.role) > rank(role)) role = g.role;
    if (g.role === "owner") wt.add("*");
    for (const t of g.writeTypes) wt.add(t);
  }
  if (role === null) return null;
  return { role, writeTypes: normalizeWriteTypes([...wt]) };
}

describe("account-grant fold into doco-level grant", () => {
  it("an account grant alone provides the doco grant", () => {
    const g = foldGrants([null, { role: "reader", writeTypes: ["decision"] }]);
    expect(g).toEqual({ role: "reader", writeTypes: ["decision"] });
  });
  it("account write-types union with a per-doco grant", () => {
    const g = foldGrants([
      { role: "reader", writeTypes: ["decision"] }, // account
      { role: "reader", writeTypes: ["intent"] }, // doco_users
    ]);
    expect(g?.role).toBe("reader");
    expect(new Set(g?.writeTypes)).toEqual(new Set(["decision", "intent"]));
  });
  it("an owner account grant writes everything (wildcard)", () => {
    const g = foldGrants([{ role: "owner", writeTypes: [] }]);
    expect(g).toEqual({ role: "owner", writeTypes: ["*"] });
    expect(canWriteType(g?.role, g?.writeTypes ?? [], "action")).toBe(true);
  });
  it("no sources → no grant", () => {
    expect(foldGrants([null, null])).toBeNull();
  });
});
