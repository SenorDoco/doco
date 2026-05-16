// `doco scope <subcommand>` — operations on scopes that don't fit the
// uniform PATCH/POST shape elsewhere. The first subcommand: `add-rule`,
// which authors rules from plain English prose. Maps onto the host's
// POST /<owner>/<doco>/api/scopes/<scope_id>/rules.json endpoint.
//
// Per decision_01KRPET95G2QNTPCR0YWAKSCH5 the project owner describes
// the rule in their own words; the host's LLM classifier maps that onto
// the most-fitting deterministic predicate (requires_edge,
// requires_field, mandatory_scope, …) when one fits, otherwise persists
// the prose as a probabilistic rule the LLM judges at capture time. The
// classifier ALWAYS rejects when the host can't reach OpenAI — there is
// no silent fallback. Multi-rule prose splits into separate rows.
import { defineCommand } from "citty";
import { c, cross } from "../output.js";
import { requireDocoConfig } from "../env.js";

const DOCO_BASE_URL = "https://doco.to";

interface ClassifiedRow {
  text: string;
  rule: { kind: string };
}

const addRuleCmd = defineCommand({
  meta: {
    name: "add-rule",
    description:
      "Add one or more rules to a scope from plain English prose. The host's LLM classifier splits multi-rule prose and picks the most-fitting deterministic predicate, or keeps the prose verbatim as a probabilistic rule.",
  },
  args: {
    "scope-id": {
      type: "string",
      description: "Required. The target scope's ULID (e.g. 'scope_01KR…').",
      required: true,
    },
    prose: {
      type: "string",
      description:
        "Required. The rule(s) in plain English. Multi-rule sentences (\"A and B should …\") are split automatically.",
      required: true,
    },
  },
  async run({ args }) {
    const scopeId = String(args["scope-id"]);
    const prose = String(args.prose);
    if (!scopeId.startsWith("scope_")) {
      console.error(cross(`--scope-id must start with 'scope_' (got '${scopeId}').`));
      process.exit(2);
    }
    if (prose.trim().length === 0) {
      console.error(cross("--prose must not be empty."));
      process.exit(2);
    }

    const { token, docoId } = requireDocoConfig();
    const url = `${DOCO_BASE_URL}/by-id/${encodeURIComponent(docoId)}/api/scopes/${encodeURIComponent(scopeId)}/rules.json`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prose }),
      });
    } catch (e) {
      console.error(cross(`Network error POSTing ${url}: ${(e as Error).message}`));
      process.exit(1);
    }
    const text = await resp.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!resp.ok) {
      const errMsg =
        parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : text;
      console.error(cross(`HTTP ${resp.status}: ${errMsg}`));
      process.exit(1);
    }
    const obj = (parsed ?? {}) as {
      footer_lines?: string[];
      added?: ClassifiedRow[];
    };
    if (Array.isArray(obj.added) && obj.added.length > 0) {
      // Print a one-liner per classified rule so the operator sees what
      // got persisted before the footer-line block.
      for (const c of obj.added) {
        console.log(`  + [${c.rule.kind}] ${c.text}`);
      }
    }
    if (Array.isArray(obj.footer_lines) && obj.footer_lines.length > 0) {
      for (const line of obj.footer_lines) console.log(line);
    } else {
      console.log(text);
    }
  },
});

// v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG). Bulk + structural operations
// on a scope: activate / draft / validate / exclude-rule. Each one is a
// thin wrapper around its doco.to endpoint — the bulk logic (enumerate
// scope + descendants, fetch members, evaluate rules, write
// transactionally) lives server-side in
// packages/web/app/lib/scope-bulk.server.ts.

async function postScopeVerb(
  scopeId: string,
  verb: "activate" | "draft" | "validate" | "excluded-rules",
  body: Record<string, unknown> = {},
): Promise<void> {
  if (!scopeId.startsWith("scope_")) {
    console.error(cross(`--scope-id must start with 'scope_' (got '${scopeId}').`));
    process.exit(2);
  }
  const { token, docoId } = requireDocoConfig();
  const url = `${DOCO_BASE_URL}/by-id/${encodeURIComponent(docoId)}/api/scopes/${encodeURIComponent(scopeId)}/${verb}.json`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(cross(`Network error POSTing ${url}: ${(e as Error).message}`));
    process.exit(1);
  }
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!resp.ok) {
    const errMsg =
      parsed && typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : text;
    console.error(cross(`HTTP ${resp.status}: ${errMsg}`));
    // Surface validation failures for activate / validate.
    if (parsed && typeof parsed === "object" && parsed !== null && "failures" in parsed) {
      const fs = (parsed as { failures: { id: string; node_type: string; error?: string }[] })
        .failures;
      if (Array.isArray(fs)) {
        for (const f of fs.slice(0, 20)) {
          console.error(`  - ${f.node_type}/${f.id}: ${f.error ?? "(no detail)"}`);
        }
        if (fs.length > 20) console.error(`  ...and ${fs.length - 20} more`);
      }
    }
    process.exit(1);
  }
  console.log(text);
}

const activateCmd = defineCommand({
  meta: {
    name: "activate",
    description:
      "Flip every drafted node in this scope (and descendants) to lifecycle=active. Re-runs the rules engine on each candidate first; aborts on the first failure with the violations listed.",
  },
  args: {
    "scope-id": {
      type: "string",
      description: "Required. The target scope's ULID.",
      required: true,
    },
  },
  async run({ args }) {
    await postScopeVerb(String(args["scope-id"]), "activate");
  },
});

const draftCmd = defineCommand({
  meta: {
    name: "draft",
    description:
      "Flip every active node in this scope (and descendants) back to lifecycle=drafted. Inverse of `activate`; no validation.",
  },
  args: {
    "scope-id": {
      type: "string",
      description: "Required. The target scope's ULID.",
      required: true,
    },
  },
  async run({ args }) {
    await postScopeVerb(String(args["scope-id"]), "draft");
  },
});

const validateScopeCmd = defineCommand({
  meta: {
    name: "validate",
    description:
      "Re-evaluate the rules engine against every node in this scope (and descendants) at its current lifecycle. Returns the violation list; no DB writes.",
  },
  args: {
    "scope-id": {
      type: "string",
      description: "Required. The target scope's ULID.",
      required: true,
    },
  },
  async run({ args }) {
    await postScopeVerb(String(args["scope-id"]), "validate");
  },
});

const excludeRuleCmd = defineCommand({
  meta: {
    name: "exclude-rule",
    description:
      "Add a Rule id to this scope's `excluded_rules` so an inherited authoring rule no longer fires for captures into this scope. The Rule keeps its citation elsewhere; only this one scope opts out.",
  },
  args: {
    "scope-id": {
      type: "string",
      description: "Required. The target scope's ULID.",
      required: true,
    },
    rule: {
      type: "string",
      description: "Required. The Rule id to exclude (e.g. 'rule_01KR…').",
      required: true,
    },
  },
  async run({ args }) {
    const ruleId = String(args.rule);
    if (!ruleId.startsWith("rule_")) {
      console.error(cross(`--rule must start with 'rule_' (got '${ruleId}').`));
      process.exit(2);
    }
    await postScopeVerb(String(args["scope-id"]), "excluded-rules", { rule_id: ruleId });
  },
});

export const scopeCmd = defineCommand({
  meta: {
    name: "scope",
    description:
      "Scope operations that don't fit the uniform PATCH/POST shape: `add-rule` for prose-driven rule authoring; v7 bulk verbs `activate` / `draft` / `validate` / `exclude-rule`.",
  },
  subCommands: {
    "add-rule": addRuleCmd,
    activate: activateCmd,
    draft: draftCmd,
    validate: validateScopeCmd,
    "exclude-rule": excludeRuleCmd,
  },
});

void c;
