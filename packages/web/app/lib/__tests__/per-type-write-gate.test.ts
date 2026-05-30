import { canWriteType, normalizeWriteTypes } from "@doco/shared";
import { describe, expect, it } from "vitest";

// Engine-level semantics for the per-type write gate
// (decision_per_type_write_grants). getDocoLevelGrant / canWriteDocoType
// are DB-bound (covered by integration tests); here we lock the pure
// combination rules the gate relies on, including the token-cap AND-ing.

// Mirror of doco-access.server.ts#tokenWriteTypeCap for unit coverage of
// the back-compat + AND-ing rules without a live request/token.
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
    else if (token.granted_doco_roles[meta.docoId] === "writer") caps.add("*");
  }
  if (meta.ownerId.startsWith("organization_") && token.granted_org_ids.includes(meta.ownerId)) {
    matched = true;
    const wt = token.granted_org_write_types[meta.ownerId];
    if (wt) for (const t of normalizeWriteTypes(wt)) caps.add(t);
    else if (token.granted_org_roles[meta.ownerId] === "writer") caps.add("*");
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
  it("wildcard membership (backfilled writer) writes everything", () => {
    expect(canWriteType("reader", ["*"], "sequence_flow")).toBe(true);
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

  it("legacy writer-role token (no per-type map) → wildcard cap", () => {
    const cap = tokenCap(orgDoco, {
      ...emptyToken,
      granted_doco_ids: ["doco_1"],
      granted_doco_roles: { doco_1: "writer" },
    });
    expect(cap).toEqual(["*"]);
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
