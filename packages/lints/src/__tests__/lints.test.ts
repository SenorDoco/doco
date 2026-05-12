import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reindex, openDb } from "@doco/index";
import { runAllLints } from "../index.js";

const REPO_ROOT = resolve(__dirname, "../../../../docos/torrenegra/doco");

describe("system lints against the Doco project", () => {
  it("reports a clean Doco (zero errors)", async () => {
    await reindex(REPO_ROOT);
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      const report = runAllLints(db);
      expect(report.errors).toBe(0);
    } finally {
      db.close();
    }
  });

  it("agent-ancestry: claude is owned by torrenegra (human) — passes", async () => {
    await reindex(REPO_ROOT);
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      const report = runAllLints(db);
      const ancestry = report.issuesByLint["agent-ancestry"] ?? [];
      expect(ancestry).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("orphan-reasoning: bootstrap reasoning has a real conclusion_ref", async () => {
    await reindex(REPO_ROOT);
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      const report = runAllLints(db);
      const orphans = report.issuesByLint["orphan-reasoning"] ?? [];
      expect(orphans).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("follows-cycle: meta-Doco has no follows cycles", async () => {
    await reindex(REPO_ROOT);
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    try {
      const report = runAllLints(db);
      const cycles = report.issuesByLint["follows-cycle"] ?? [];
      expect(cycles).toEqual([]);
    } finally {
      db.close();
    }
  });
});

import BetterSqlite3 from "better-sqlite3";
import { lintFollowsCycle } from "../follows-cycle.js";

describe("follows-cycle lint — synthetic graphs", () => {
  function setupDb(edges: { from: string; to: string }[]) {
    const db = new BetterSqlite3(":memory:");
    db.exec(`
      CREATE TABLE edges (
        from_id TEXT NOT NULL,
        from_node_type TEXT NOT NULL,
        to_id TEXT NOT NULL,
        to_node_type TEXT NOT NULL,
        edge_type TEXT NOT NULL
      );
    `);
    const ins = db.prepare(
      "INSERT INTO edges (from_id, from_node_type, to_id, to_node_type, edge_type) VALUES (?, ?, ?, ?, 'follows')",
    );
    for (const e of edges) {
      ins.run(e.from, "action", e.to, "action");
    }
    return db;
  }

  it("acyclic chain → clean", () => {
    const db = setupDb([
      { from: "action_a", to: "action_b" },
      { from: "action_b", to: "action_c" },
      { from: "action_c", to: "action_d" },
    ]);
    expect(lintFollowsCycle(db)).toEqual([]);
    db.close();
  });

  it("self-loop → cycle reported", () => {
    const db = setupDb([{ from: "action_a", to: "action_a" }]);
    const issues = lintFollowsCycle(db);
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("Cycle in 'follows'");
    db.close();
  });

  it("two-node cycle → reported once", () => {
    const db = setupDb([
      { from: "action_a", to: "action_b" },
      { from: "action_b", to: "action_a" },
    ]);
    const issues = lintFollowsCycle(db);
    expect(issues.length).toBe(1);
    db.close();
  });

  it("three-node cycle → reported once", () => {
    const db = setupDb([
      { from: "action_a", to: "action_b" },
      { from: "action_b", to: "action_c" },
      { from: "action_c", to: "action_a" },
    ]);
    const issues = lintFollowsCycle(db);
    expect(issues.length).toBe(1);
    db.close();
  });

  it("acyclic + cycle in disjoint subgraphs → only cycle reported", () => {
    const db = setupDb([
      { from: "action_a", to: "action_b" }, // chain
      { from: "action_x", to: "action_y" }, // cycle pair
      { from: "action_y", to: "action_x" },
    ]);
    const issues = lintFollowsCycle(db);
    expect(issues.length).toBe(1);
    db.close();
  });
});
