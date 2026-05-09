import { describe, expect, it } from "vitest";
import { evaluate, tryParsePredicate, type Predicate } from "../predicate.js";

describe("predicate evaluator", () => {
  it("eq with paths and literals", () => {
    const ctx = { actor: { type: "human" } };
    const pred: Predicate = { op: "eq", left: { path: "actor.type" }, right: "human" };
    expect(evaluate(pred, ctx).ok).toBe(true);

    const pred2: Predicate = { op: "eq", left: { path: "actor.type" }, right: "agent" };
    expect(evaluate(pred2, ctx).ok).toBe(false);
  });

  it("ne / lt / lte / gt / gte", () => {
    const ctx = { x: 5 };
    expect(evaluate({ op: "lt", left: { path: "x" }, right: 10 }, ctx).ok).toBe(true);
    expect(evaluate({ op: "gte", left: { path: "x" }, right: 5 }, ctx).ok).toBe(true);
    expect(evaluate({ op: "ne", left: { path: "x" }, right: 5 }, ctx).ok).toBe(false);
  });

  it("in operator", () => {
    const ctx = { kind: "block" };
    expect(
      evaluate(
        { op: "in", left: { path: "kind" }, right: ["block", "warn", "log"] },
        ctx,
      ).ok,
    ).toBe(true);
    expect(evaluate({ op: "in", left: { path: "kind" }, right: ["warn"] }, ctx).ok).toBe(false);
  });

  it("and / or / not", () => {
    const ctx = { x: 5, type: "human" };
    expect(
      evaluate(
        {
          op: "and",
          args: [
            { op: "eq", left: { path: "type" }, right: "human" },
            { op: "lt", left: { path: "x" }, right: 10 },
          ],
        },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluate(
        {
          op: "or",
          args: [
            { op: "eq", left: { path: "type" }, right: "agent" },
            { op: "lt", left: { path: "x" }, right: 10 },
          ],
        },
        ctx,
      ).ok,
    ).toBe(true);
    expect(
      evaluate({ op: "not", arg: { op: "eq", left: { path: "type" }, right: "agent" } }, ctx).ok,
    ).toBe(true);
  });

  it("matches_regex on display_name (PII rule shape)", () => {
    const ctx = { display_name: "alice@example.com" };
    expect(
      evaluate({ op: "matches_regex", left: { path: "display_name" }, right: "@.+\\." }, ctx).ok,
    ).toBe(true);
  });

  it("path_exists / is_null", () => {
    const ctx = { a: { b: 1 }, n: null };
    expect(evaluate({ op: "path_exists", path: "a.b" }, ctx).ok).toBe(true);
    expect(evaluate({ op: "path_exists", path: "a.c" }, ctx).ok).toBe(false);
    expect(evaluate({ op: "is_null", path: "n" }, ctx).ok).toBe(true);
    expect(evaluate({ op: "is_null", path: "a.b" }, ctx).ok).toBe(false);
  });

  it("tryParsePredicate on JSON / non-JSON strings", () => {
    expect(tryParsePredicate(`{"op":"eq","left":{"path":"x"},"right":1}`)?.op).toBe("eq");
    expect(tryParsePredicate(`actor.type == 'human'`)).toBeNull();
    expect(tryParsePredicate(`not json`)).toBeNull();
  });
});
