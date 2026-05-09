import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalo } from "../loader.js";

const REPO_ROOT = resolve(__dirname, "../../../..");

describe("loadEvalo against the Evalo project's self-hosted Evalo", () => {
  it("loads the root evalo.yaml", async () => {
    const loaded = await loadEvalo(REPO_ROOT);
    expect(loaded.evalo.node_type).toBe("evalo");
    expect(loaded.evalo.slug).toBe("torrenegra/evalo");
    expect(loaded.evalo.visibility).toBe("private");
  });

  it("loads at least the bootstrap entity counts", async () => {
    const loaded = await loadEvalo(REPO_ROOT);
    expect(loaded.byType.get("principal")?.length).toBe(2);
    expect(loaded.byType.get("tag")?.length).toBe(6);
    expect(loaded.byType.get("reference")?.length).toBe(3);
    expect(loaded.byType.get("intent")?.length).toBe(6);
    expect(loaded.byType.get("rule")?.length).toBe(5);
    expect(loaded.byType.get("decision")?.length).toBeGreaterThanOrEqual(45);
    expect(loaded.byType.get("action")?.length).toBe(1);
    expect(loaded.byType.get("reasoning")?.length).toBe(1);
  });

  it("indexes every loaded entity by id", async () => {
    const loaded = await loadEvalo(REPO_ROOT);
    for (const [id, le] of loaded.entities) {
      expect(id).toBe(le.entity.id);
    }
  });

  it("has zero load failures", async () => {
    const loaded = await loadEvalo(REPO_ROOT);
    expect(loaded.failures).toEqual([]);
  });
});
