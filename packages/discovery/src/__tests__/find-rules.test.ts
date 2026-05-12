import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openDb, reindex } from "@doco/index";
import { Glossary, findRules } from "../index.js";

const REPO_ROOT = resolve(__dirname, "../../../..");

beforeAll(async () => {
  await reindex(REPO_ROOT);
});

describe("find-rules", () => {
  it("strategy 1 (structural): finds the only-humans-delete rule for an agent delete_doco", async () => {
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    const glossary = await Glossary.load(REPO_ROOT);
    try {
      const result = findRules(db, glossary, {
        candidate: {
          node_type: "action",
          verb: "delete_doco",
          actor_id: "principal_01KR441EA259F7EE420Z4VWFPJ",
        },
      });
      expect(result.precise.find((h) => h.rule_slug === "only-humans-delete-doco")).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("strategy 4 (FTS): finds priority-related rules from a description", async () => {
    const db = await openDb(REPO_ROOT, { readonly: true, fileMustExist: true });
    const glossary = await Glossary.load(REPO_ROOT);
    try {
      const result = findRules(db, glossary, { description: "priority order tradeoffs" });
      expect(result.possiblyRelevant.length).toBeGreaterThan(0);
      expect(result.possiblyRelevant.some((h) => h.rule_slug === "priority-order")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("glossary expansion: 'validation' expands to 'input sanitization' synonyms", async () => {
    const glossary = await Glossary.load(REPO_ROOT);
    const expanded = glossary.expand("validation");
    expect(expanded).toContain("validation");
    expect(expanded).toContain("input sanitization");
  });
});
