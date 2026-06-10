// Parity: the authoring contract presents node types and relation kinds as
// peers. Node types are `node_types` (each entry keyed by `node_type`) — the
// privileged word "entity" no longer stands in for "node" — sitting alongside
// `relation_kinds`. The create op shape advertises `node_type`, not entity_type.

import { describe, expect, it, vi } from "vitest";

vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: vi.fn(async () => ({ meta: { docoId: "doco_acme" } })),
}));
vi.mock("~/lib/perspectives.server", () => ({
  listPerspectivesForDoco: vi.fn(async () => []),
}));

import { loader } from "../$docoHandle.api.authoring-contract[.]json";

describe("authoring contract — node and relation types are peers", () => {
  it("lists node_types (not entity_types) alongside relation_kinds", async () => {
    const res = await loader({
      request: new Request("https://doco.test/acme/api/authoring-contract.json"),
      params: { docoHandle: "acme" },
    });
    const body = (await res.json()) as Record<string, unknown>;

    // Node types are first-class and named `node_types`, a peer of relation_kinds.
    expect(body).toHaveProperty("node_types");
    expect(body).toHaveProperty("relation_kinds");
    expect(body).not.toHaveProperty("entity_types");

    const nodeTypes = body.node_types as Array<Record<string, unknown>>;
    // Each entry's discriminator is `node_type`, never `entity_type`.
    expect(nodeTypes.every((t) => typeof t.node_type === "string" && !("entity_type" in t))).toBe(
      true,
    );
    expect(nodeTypes.map((t) => t.node_type)).toEqual(
      expect.arrayContaining(["decision", "action", "principal"]),
    );

    // The create op shape advertises node_type, not entity_type.
    const ops = body.operations as { create: { shape: Record<string, unknown> } };
    expect(ops.create.shape).toHaveProperty("node_type");
    expect(ops.create.shape).not.toHaveProperty("entity_type");
  });
});
