import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matches } from "../scope.js";

describe("ScopeSelector matcher (matches)", () => {
  it("returns false for null / undefined / non-object selectors", () => {
    expect(matches(null, { node_type: "action" })).toBe(false);
    expect(matches(undefined, { node_type: "action" })).toBe(false);
    expect(matches("nope", { node_type: "action" })).toBe(false);
    expect(matches(42, { node_type: "action" })).toBe(false);
  });

  describe("{ all: true } wildcard", () => {
    it("matches any candidate", () => {
      expect(matches({ all: true }, { node_type: "action" })).toBe(true);
      expect(matches({ all: true }, { node_type: "decision" })).toBe(true);
      expect(matches({ all: true }, {})).toBe(true);
    });
  });

  describe("{ id }", () => {
    it("matches exact entity id", () => {
      expect(matches({ id: "decision_01" }, { id: "decision_01" })).toBe(true);
      expect(matches({ id: "decision_01" }, { id: "decision_02" })).toBe(false);
    });
  });

  describe("{ node_type, ...field equality }", () => {
    it("matches when every field is equal on the candidate", () => {
      expect(matches({ node_type: "action", verb: "deploy" }, { node_type: "action", verb: "deploy" })).toBe(true);
    });
    it("fails when a field differs", () => {
      expect(matches({ node_type: "action", verb: "deploy" }, { node_type: "action", verb: "ship" })).toBe(false);
    });
    it("fails when a selector field is missing on the candidate", () => {
      expect(matches({ node_type: "action", verb: "deploy" }, { node_type: "action" })).toBe(false);
    });
  });

  describe("{ any_of: [...] }", () => {
    it("matches when any sub-selector matches", () => {
      const sel = { any_of: [{ node_type: "action" }, { node_type: "decision" }] };
      expect(matches(sel, { node_type: "action" })).toBe(true);
      expect(matches(sel, { node_type: "decision" })).toBe(true);
      expect(matches(sel, { node_type: "intent" })).toBe(false);
    });
  });

  describe("{ all_of: [...] }", () => {
    it("matches only when every sub-selector matches", () => {
      const sel = { all_of: [{ node_type: "action" }, { verb: "deploy" }] };
      expect(matches(sel, { node_type: "action", verb: "deploy" })).toBe(true);
      expect(matches(sel, { node_type: "action", verb: "ship" })).toBe(false);
    });
  });

  describe("{ scope } (db-resolved)", () => {
    let db: BetterSqlite3.Database;
    beforeEach(() => {
      db = new BetterSqlite3(":memory:");
      db.exec(`
        CREATE TABLE scope (id TEXT PRIMARY KEY, name TEXT);
        INSERT INTO scope (id, name) VALUES ('scope_a', 'auth'), ('scope_m', 'meta');
      `);
    });
    afterEach(() => db.close());

    it("matches when candidate.scopes contains a scope id whose name equals the selector", () => {
      expect(matches({ scope: "auth" }, { node_type: "decision", scopes: ["scope_a"] }, db)).toBe(true);
    });
    it("fails when the candidate carries a different scope", () => {
      expect(matches({ scope: "auth" }, { node_type: "decision", scopes: ["scope_m"] }, db)).toBe(false);
    });
    it("fails without a db (scope name → id lookup unavailable)", () => {
      expect(matches({ scope: "auth" }, { node_type: "decision", scopes: ["scope_a"] })).toBe(false);
    });
    it("fails when candidate has no scopes array", () => {
      expect(matches({ scope: "auth" }, { node_type: "decision" }, db)).toBe(false);
    });
  });

  describe("{ intent_id } (graph fallback)", () => {
    let db: BetterSqlite3.Database;
    beforeEach(() => {
      db = new BetterSqlite3(":memory:");
      db.exec(`
        CREATE TABLE edges (
          from_id TEXT, to_id TEXT, edge_type TEXT,
          PRIMARY KEY (from_id, to_id, edge_type)
        );
        INSERT INTO edges VALUES ('decision_x', 'intent_y', 'serves');
      `);
    });
    afterEach(() => db.close());

    it("matches when candidate.intent_ids includes the selector", () => {
      expect(
        matches({ intent_id: "intent_y" }, { node_type: "decision", intent_ids: ["intent_y"] }, db),
      ).toBe(true);
    });
    it("falls back to a 'serves' edge in the graph when intent_ids is missing", () => {
      expect(matches({ intent_id: "intent_y" }, { node_type: "decision", id: "decision_x" }, db)).toBe(true);
    });
    it("fails when neither field nor edge connects to the intent", () => {
      expect(matches({ intent_id: "intent_z" }, { node_type: "decision", id: "decision_x" }, db)).toBe(false);
    });
  });

  describe("{ actor_type } (principal lookup)", () => {
    let db: BetterSqlite3.Database;
    beforeEach(() => {
      db = new BetterSqlite3(":memory:");
      db.exec(`
        CREATE TABLE principal (id TEXT PRIMARY KEY, type TEXT);
        INSERT INTO principal VALUES ('principal_h', 'human'), ('principal_a', 'agent');
      `);
    });
    afterEach(() => db.close());

    it("matches when the action's actor is the right type", () => {
      expect(
        matches({ actor_type: "human" }, { node_type: "action", actor_id: "principal_h" }, db),
      ).toBe(true);
      expect(
        matches({ actor_type: "agent" }, { node_type: "action", actor_id: "principal_a" }, db),
      ).toBe(true);
    });
    it("fails when actor type differs", () => {
      expect(
        matches({ actor_type: "human" }, { node_type: "action", actor_id: "principal_a" }, db),
      ).toBe(false);
    });
    it("fails on non-action candidates", () => {
      expect(
        matches({ actor_type: "human" }, { node_type: "decision", actor_id: "principal_h" }, db),
      ).toBe(false);
    });
    it("fails without a db (no principal lookup)", () => {
      expect(
        matches({ actor_type: "human" }, { node_type: "action", actor_id: "principal_h" }),
      ).toBe(false);
    });
    it("fails when the actor_id doesn't resolve", () => {
      expect(
        matches({ actor_type: "human" }, { node_type: "action", actor_id: "principal_missing" }, db),
      ).toBe(false);
    });
  });
});
