/**
 * Tiny JSON DSL for Rule predicates per ADR-048.
 *
 * Examples:
 *   { "op": "eq", "left": { "path": "actor.type" }, "right": "human" }
 *   { "op": "and", "args": [ <pred>, <pred> ] }
 *   { "op": "matches_regex", "left": { "path": "display_name" }, "right": "^.+@.+$" }
 */

export type ValueExpr =
  | { path: string }
  | { value: unknown }
  | string
  | number
  | boolean
  | null;

export type Predicate =
  | { op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; left: ValueExpr; right: ValueExpr }
  | { op: "in"; left: ValueExpr; right: ValueExpr[] }
  | { op: "and" | "or"; args: Predicate[] }
  | { op: "not"; arg: Predicate }
  | { op: "matches_regex"; left: ValueExpr; right: string }
  | { op: "path_exists" | "is_null"; path: string };

export type Context = Record<string, unknown>;

export interface EvaluationResult {
  ok: boolean;
  reason?: string | undefined;
}

export function evaluate(pred: Predicate, ctx: Context): EvaluationResult {
  switch (pred.op) {
    case "eq":
      return cmp(resolve(pred.left, ctx), resolve(pred.right, ctx), (a, b) => a === b, "==");
    case "ne":
      return cmp(resolve(pred.left, ctx), resolve(pred.right, ctx), (a, b) => a !== b, "!=");
    case "lt":
      return cmp(resolve(pred.left, ctx), resolve(pred.right, ctx), (a, b) => (a as number) < (b as number), "<");
    case "lte":
      return cmp(resolve(pred.left, ctx), resolve(pred.right, ctx), (a, b) => (a as number) <= (b as number), "<=");
    case "gt":
      return cmp(resolve(pred.left, ctx), resolve(pred.right, ctx), (a, b) => (a as number) > (b as number), ">");
    case "gte":
      return cmp(resolve(pred.left, ctx), resolve(pred.right, ctx), (a, b) => (a as number) >= (b as number), ">=");
    case "in": {
      const left = resolve(pred.left, ctx);
      const right = pred.right.map((v) => resolve(v, ctx));
      const ok = right.some((v) => v === left);
      return { ok, reason: ok ? undefined : `${stringify(left)} not in [${right.map(stringify).join(", ")}]` };
    }
    case "and": {
      for (const arg of pred.args) {
        const r = evaluate(arg, ctx);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    case "or": {
      const reasons: string[] = [];
      for (const arg of pred.args) {
        const r = evaluate(arg, ctx);
        if (r.ok) return { ok: true };
        if (r.reason) reasons.push(r.reason);
      }
      return { ok: false, reason: `none of: ${reasons.join("; ")}` };
    }
    case "not": {
      const r = evaluate(pred.arg, ctx);
      return { ok: !r.ok, reason: r.ok ? "negated truthy expression" : undefined };
    }
    case "matches_regex": {
      const left = resolve(pred.left, ctx);
      if (typeof left !== "string") return { ok: false, reason: `left side not a string: ${stringify(left)}` };
      const re = new RegExp(pred.right);
      const ok = re.test(left);
      return { ok, reason: ok ? undefined : `${stringify(left)} did not match /${pred.right}/` };
    }
    case "path_exists": {
      const v = readPath(pred.path, ctx);
      return { ok: v !== undefined };
    }
    case "is_null": {
      const v = readPath(pred.path, ctx);
      return { ok: v === null || v === undefined };
    }
  }
}

function cmp(
  left: unknown,
  right: unknown,
  fn: (a: unknown, b: unknown) => boolean,
  sym: string,
): EvaluationResult {
  const ok = fn(left, right);
  return ok ? { ok: true } : { ok: false, reason: `${stringify(left)} ${sym} ${stringify(right)} is false` };
}

function resolve(expr: ValueExpr, ctx: Context): unknown {
  if (expr === null || typeof expr !== "object") return expr;
  if ("path" in expr) return readPath(expr.path, ctx);
  if ("value" in expr) return expr.value;
  return undefined;
}

function readPath(path: string, ctx: Context): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

/** Try parsing a Rule.predicate string as our JSON DSL. Returns null if it isn't JSON. */
export function tryParsePredicate(text: string): Predicate | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as Predicate;
  } catch {
    return null;
  }
}
