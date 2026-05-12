import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDoco } from "../loader.js";

const REPO_ROOT = resolve(__dirname, "../../../../docos/torrenegra/doco");

describe("loadDoco against the Doco project's self-hosted Doco", () => {
  it("loads the root doco.yaml", async () => {
    const loaded = await loadDoco(REPO_ROOT);
    expect(loaded.doco.node_type).toBe("doco");
    expect(loaded.doco.slug).toBe("torrenegra/doco");
    expect(loaded.doco.visibility).toBe("private");
  });

  it("loads at least the bootstrap entity counts", async () => {
    const loaded = await loadDoco(REPO_ROOT);
    expect(loaded.byType.get("principal")?.length).toBe(2);
    expect(loaded.byType.get("scope")?.length).toBe(6);
    expect(loaded.byType.get("reference")?.length).toBe(3);
    expect(loaded.byType.get("intent")?.length).toBe(7);
    expect(loaded.byType.get("rule")?.length).toBe(8);
    expect(loaded.byType.get("decision")?.length).toBeGreaterThanOrEqual(79);
    expect(loaded.byType.get("idea")?.length).toBeGreaterThanOrEqual(1);
    expect(loaded.byType.get("action")?.length).toBeGreaterThanOrEqual(14);
    expect(loaded.byType.get("reasoning")?.length).toBeGreaterThanOrEqual(2);
  });

  it("indexes every loaded entity by id", async () => {
    const loaded = await loadDoco(REPO_ROOT);
    for (const [id, le] of loaded.entities) {
      expect(id).toBe(le.entity.id);
    }
  });

  it("has zero load failures", async () => {
    const loaded = await loadDoco(REPO_ROOT);
    expect(loaded.failures).toEqual([]);
  });
});
