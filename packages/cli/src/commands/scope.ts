// `doco scope <subcommand>` — operations on scopes that don't fit the
// uniform PATCH/POST shape elsewhere. The first subcommand: `add-rule`,
// which authors rules from plain English prose. Maps onto the host's
// POST /<doco-handle>/api/scopes/<scope_id>/rules.json endpoint.
//
// Per decision_01KRPET95G2QNTPCR0YWAKSCH5 the project owner describes
// the rule in their own words and declares whether it is an authoring
// rule or a guidance rule. Authoring prose goes through the LLM classifier
// and may split into separate authoring rows. Guidance prose is saved as
// one verbatim Rule.
import { defineCommand } from "citty";
import { requireDocoConfig } from "../env.js";
import { c, cross } from "../output.js";

// Host comes from requireDocoConfig() so DOCO_HOST overrides for local dev.

interface ClassifiedRow {
  bucket?: string;
  text: string;
  rule?: { kind: string };
}

const addRuleCmd = defineCommand({
  meta: {
    name: "add-rule",
    description:
      "Add a guidance rule or one or more authoring rules to a scope from plain English prose.",
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
        "Required. The rule(s) in plain English. Guidance is saved as-is; authoring prose may split into separate checks.",
      required: true,
    },
    kind: {
      type: "string",
      description: "Optional. `authoring` (default) or `guidance`.",
      required: false,
    },
  },
  async run({ args }) {
    const scopeId = String(args["scope-id"]);
    const prose = String(args.prose);
    const kind = String(args.kind ?? "authoring");
    if (!scopeId.startsWith("scope_")) {
      console.error(cross(`--scope-id must start with 'scope_' (got '${scopeId}').`));
      process.exit(2);
    }
    if (kind !== "authoring" && kind !== "guidance") {
      console.error(cross("--kind must be either 'authoring' or 'guidance'."));
      process.exit(2);
    }
    if (prose.trim().length === 0) {
      console.error(cross("--prose must not be empty."));
      process.exit(2);
    }

    const { token, docoId, host } = requireDocoConfig();
    const url = `${host}/by-id/${encodeURIComponent(docoId)}/api/scopes/${encodeURIComponent(scopeId)}/rules.json`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ kind, prose }),
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
        console.log(`  + [${c.rule?.kind ?? c.bucket ?? "guidance"}] ${c.text}`);
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
  const { token, docoId, host } = requireDocoConfig();
  const url = `${host}/by-id/${encodeURIComponent(docoId)}/api/scopes/${encodeURIComponent(scopeId)}/${verb}.json`;
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
      "Scope operations that don't fit the uniform PATCH/POST shape: `add-rule` for prose-driven rule creation; v7 bulk verbs `activate` / `draft` / `validate` / `exclude-rule`.",
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
