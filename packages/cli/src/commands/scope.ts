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

export const scopeCmd = defineCommand({
  meta: {
    name: "scope",
    description:
      "Scope operations that don't fit the uniform PATCH/POST shape — currently `add-rule` for prose-driven rule authoring.",
  },
  subCommands: {
    "add-rule": addRuleCmd,
  },
});

void c;
