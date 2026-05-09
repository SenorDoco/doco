import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { reindex, openDb } from "@evalo/index";
import { runAllLints } from "../index.js";

const REPO_ROOT = resolve(__dirname, "../../../..");

describe("system lints against the Evalo project", () => {
  it("reports a clean Evalo (zero errors)", async () => {
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
});
