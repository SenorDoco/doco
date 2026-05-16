import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { requireDocoConfig } from "../env.js";
import { c, cross } from "../output.js";

// Host comes from requireDocoConfig() so DOCO_HOST overrides for local dev.

function splitList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseJson<T>(s: string | undefined, fieldName: string): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch (e) {
    console.error(cross(`--${fieldName} is not valid JSON: ${(e as Error).message}`));
    process.exit(2);
  }
}

function readBody(inline: string | undefined, fromFile: string | undefined): string | undefined {
  if (inline && fromFile) {
    console.error(cross("Pass only one of --body-md or --body-md-file."));
    process.exit(2);
  }
  if (fromFile) return readFileSync(resolve(process.cwd(), fromFile), "utf8");
  return inline;
}

async function postCapture(
  type:
    | "intents"
    | "decisions"
    | "evals"
    | "scopes"
    | "actions"
    | "logs"
    | "rules"
    | "references"
    | "states",
  body: Record<string, unknown>,
): Promise<void> {
  const { token, docoId, host } = requireDocoConfig();
  const url = `${host}/by-id/${encodeURIComponent(docoId)}/api/${type}.json`;
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
    process.exit(1);
  }
  const obj = (parsed ?? {}) as { footer_lines?: string[] };
  if (Array.isArray(obj.footer_lines) && obj.footer_lines.length > 0) {
    for (const line of obj.footer_lines) console.log(line);
  } else {
    console.log(text);
  }
}

const intentCmd = defineCommand({
  meta: {
    name: "intent",
    description: "Capture an Intent (POST /by-id/<doco_id>/api/intents.json).",
  },
  args: {
    summary: {
      type: "string",
      description: "Required. One-line 'what someone wants' summary.",
      required: true,
    },
    scope: {
      type: "string",
      description: "Required. Comma-separated scope names (bare, e.g. 'framework,user-flows').",
      required: true,
    },
    title: { type: "string", description: "Optional short title (defaults to summary)." },
    "body-md": { type: "string", description: "Optional markdown body (inline string)." },
    "body-md-file": {
      type: "string",
      description: "Optional path to a file whose contents become body_md.",
    },
    "wanted-by-username": {
      type: "string",
      description: "Optional principal username who wants this.",
    },
    lifecycle: { type: "string", description: "Optional. Defaults to 'active'." },
  },
  async run({ args }) {
    const body: Record<string, unknown> = {
      summary: args.summary,
      scope_names: splitList(args.scope as string),
    };
    if (args.title) body.title = args.title;
    const bodyMd = readBody(
      args["body-md"] as string | undefined,
      args["body-md-file"] as string | undefined,
    );
    if (bodyMd !== undefined) body.body_md = bodyMd;
    if (args["wanted-by-username"]) body.wanted_by_username = args["wanted-by-username"];
    if (args.lifecycle) body.lifecycle = args.lifecycle;
    await postCapture("intents", body);
  },
});

const decisionCmd = defineCommand({
  meta: {
    name: "decision",
    description: "Capture a Decision (POST /by-id/<doco_id>/api/decisions.json).",
  },
  args: {
    question: {
      type: "string",
      description: "Required. The question the Decision answers.",
      required: true,
    },
    chosen: {
      type: "string",
      description: "Required. The chosen resolution (multi-line ok).",
      required: true,
    },
    scope: {
      type: "string",
      description: "Required. Comma-separated scope names.",
      required: true,
    },
    summary: {
      type: "string",
      description: "Optional one-line summary; derived from chosen if absent.",
    },
    "intent-id": { type: "string", description: "Optional. Comma-separated intent ids to link." },
    alternatives: {
      type: "string",
      description: 'Required JSON: \'[{"name":"X","rejected_because":"Y"}]\'.',
      required: true,
    },
    "decided-by-username": {
      type: "string",
      description: "Optional principal username who made the decision.",
    },
    "body-md": { type: "string", description: "Optional markdown body (inline string)." },
    "body-md-file": {
      type: "string",
      description: "Optional path to a file whose contents become body_md.",
    },
    "born-from": {
      type: "string",
      description: "Optional id of an origin entity (e.g. bugfix Decision).",
    },
    lifecycle: { type: "string", description: "Optional. Defaults to 'active'." },
  },
  async run({ args }) {
    const body: Record<string, unknown> = {
      question: args.question,
      chosen: args.chosen,
      scope_names: splitList(args.scope as string),
    };
    if (args.summary) body.summary = args.summary;
    const intents = splitList(args["intent-id"] as string | undefined);
    if (intents.length) body.intent_ids = intents;
    const alts = parseJson<{ name: string; rejected_because: string }[]>(
      args.alternatives as string | undefined,
      "alternatives",
    );
    if (alts) body.alternatives = alts;
    if (args["decided-by-username"]) body.decided_by_username = args["decided-by-username"];
    const bodyMd = readBody(
      args["body-md"] as string | undefined,
      args["body-md-file"] as string | undefined,
    );
    if (bodyMd !== undefined) body.body_md = bodyMd;
    if (args["born-from"]) body.born_from = args["born-from"];
    if (args.lifecycle) body.lifecycle = args.lifecycle;
    await postCapture("decisions", body);
  },
});

const evalCmd = defineCommand({
  meta: {
    name: "eval",
    description: "Capture an Eval (POST /by-id/<doco_id>/api/evals.json).",
  },
  args: {
    name: { type: "string", description: "Required. Human-readable name.", required: true },
    scope: {
      type: "string",
      description: "Required. Comma-separated scope names.",
      required: true,
    },
    "criterion-kind": {
      type: "string",
      description: "Required. One of: exact | shape | llm-judge.",
      required: true,
    },
    "criterion-spec": {
      type: "string",
      description: "Optional spec string accompanying the criterion.",
    },
    summary: { type: "string", description: "Optional one-line summary." },
    description: { type: "string", description: "Optional free-form description." },
    input: { type: "string", description: "Optional JSON for the input value." },
    expected: {
      type: "string",
      description: "Optional JSON for the expected outcome (or prose for llm-judge).",
    },
    "target-ref": { type: "string", description: "Optional id of the entity this Eval tests." },
    "intent-id": { type: "string", description: "Optional comma-separated intent ids." },
    "authored-by-username": {
      type: "string",
      description: "Optional principal username who authored the Eval.",
    },
    "body-md": { type: "string", description: "Optional markdown body (inline string)." },
    "body-md-file": {
      type: "string",
      description: "Optional path to a file whose contents become body_md.",
    },
    lifecycle: { type: "string", description: "Optional. Defaults to 'active'." },
  },
  async run({ args }) {
    const kind = args["criterion-kind"] as string;
    if (!["exact", "shape", "llm-judge"].includes(kind)) {
      console.error(
        cross(`--criterion-kind must be one of: exact, shape, llm-judge (got '${kind}').`),
      );
      process.exit(2);
    }
    const criterion: Record<string, unknown> = { kind };
    if (args["criterion-spec"]) criterion.spec = args["criterion-spec"];
    const body: Record<string, unknown> = {
      name: args.name,
      scope_names: splitList(args.scope as string),
      criterion,
    };
    if (args.summary) body.summary = args.summary;
    if (args.description) body.description = args.description;
    const inp = parseJson<unknown>(args.input as string | undefined, "input");
    if (inp !== undefined) body.input = inp;
    const exp = parseJson<unknown>(args.expected as string | undefined, "expected");
    if (exp !== undefined) body.expected = exp;
    if (args["target-ref"]) body.target_ref = args["target-ref"];
    const intents = splitList(args["intent-id"] as string | undefined);
    if (intents.length) body.intent_ids = intents;
    if (args["authored-by-username"]) body.authored_by_username = args["authored-by-username"];
    const bodyMd = readBody(
      args["body-md"] as string | undefined,
      args["body-md-file"] as string | undefined,
    );
    if (bodyMd !== undefined) body.body_md = bodyMd;
    if (args.lifecycle) body.lifecycle = args.lifecycle;
    await postCapture("evals", body);
  },
});

const scopeCmd = defineCommand({
  meta: {
    name: "scope",
    description:
      "Create a Scope (POST /by-id/<doco_id>/api/scopes.json). Per ADR-137bis every scope-creation call must declare --watched true or false — no default.",
  },
  args: {
    watched: {
      type: "string",
      description:
        "Required. 'true' → soft attention signal: contributors should proactively look for opportunities to document into this scope. 'false' → available but no extra prompt. NOT hard enforcement (use mandatory_scope Constitution rules for that). No default per ADR-137bis.",
      required: true,
    },
    "template-name": {
      type: "string",
      description:
        "Optional. Install a default template. The framework ships two: 'global' (auto-installed at Doco create) and 'user-flows'. Mutually exclusive with --name.",
    },
    name: {
      type: "string",
      description: "Required if --template-name absent. Lowercase letter-start, no slashes.",
    },
    icon: { type: "string", description: "Optional single emoji." },
    purpose: {
      type: "string",
      description: "Required if --template-name absent. Main Intent summary this scope serves.",
    },
    guidelines: {
      type: "string",
      description:
        "Deprecated; ignored. Add scope rules after creation with `doco scope add-rule`.",
    },
    "guidelines-file": {
      type: "string",
      description:
        "Deprecated; ignored. Add scope rules after creation with `doco scope add-rule`.",
    },
    "parent-id": {
      type: "string",
      description: "Optional id of an existing scope to nest this one under.",
    },
  },
  async run({ args }) {
    const watchedRaw = String(args.watched ?? "").toLowerCase();
    if (watchedRaw !== "true" && watchedRaw !== "false") {
      console.error(
        cross("--watched must be 'true' or 'false'. No default per ADR-137bis — pick one."),
      );
      process.exit(2);
    }
    const watched = watchedRaw === "true";
    const templateName = (args["template-name"] as string | undefined)?.trim();
    const name = (args.name as string | undefined)?.trim();
    if (!templateName && !name) {
      console.error(cross("Pass either --template-name or --name."));
      process.exit(2);
    }
    if (templateName && name) {
      console.error(cross("Pass only one of --template-name or --name."));
      process.exit(2);
    }
    const body: Record<string, unknown> = { watched };
    if (templateName) {
      body.template_name = templateName;
    } else {
      body.name = name;
      if (args.icon) body.icon = args.icon;
      if (!args.purpose) {
        console.error(cross("Pass --purpose when creating a custom scope."));
        process.exit(2);
      }
      body.intent_summary = args.purpose;
      if (args["parent-id"]) body.parent_id = args["parent-id"];
    }
    await postCapture("scopes", body);
  },
});

const actionCmd = defineCommand({
  meta: {
    name: "action",
    description: "Capture an Action (POST /by-id/<doco_id>/api/actions.json).",
  },
  args: {
    summary: {
      type: "string",
      description: "Required. One-line 'what was done' summary.",
      required: true,
    },
    scope: {
      type: "string",
      description: "Required. Comma-separated scope names.",
      required: true,
    },
    verb: {
      type: "string",
      description: "Required. Short verb (e.g. 'refactor', 'migrate').",
      required: true,
    },
    "intent-id": {
      type: "string",
      description: "Optional. Comma-separated intent ids this action serves.",
    },
    "decision-id": {
      type: "string",
      description:
        "Optional. Comma-separated decision ids this action enacts (frontmatter `decision_ids`).",
    },
    follows: {
      type: "string",
      description: "Optional. Comma-separated entity ids this action follows.",
    },
    inputs: { type: "string", description: "Optional JSON for verb-specific inputs." },
    outputs: { type: "string", description: "Optional JSON for verb-specific outputs." },
    "performed-by-username": {
      type: "string",
      description: "Optional principal username who performed the action.",
    },
    "body-md": { type: "string", description: "Optional markdown body (inline string)." },
    "body-md-file": {
      type: "string",
      description: "Optional path to a file whose contents become body_md.",
    },
    lifecycle: { type: "string", description: "Optional. Defaults to 'succeeded'." },
  },
  async run({ args }) {
    const body: Record<string, unknown> = {
      summary: args.summary,
      scope_names: splitList(args.scope as string),
      verb: args.verb,
    };
    const intents = splitList(args["intent-id"] as string | undefined);
    if (intents.length) body.intent_ids = intents;
    const decisions = splitList(args["decision-id"] as string | undefined);
    if (decisions.length) body.decision_ids = decisions;
    const follows = splitList(args.follows as string | undefined);
    if (follows.length) body.follows = follows;
    const inputs = parseJson<unknown>(args.inputs as string | undefined, "inputs");
    if (inputs !== undefined) body.inputs = inputs;
    const outputs = parseJson<unknown>(args.outputs as string | undefined, "outputs");
    if (outputs !== undefined) body.outputs = outputs;
    if (args["performed-by-username"]) body.performed_by_username = args["performed-by-username"];
    const bodyMd = readBody(
      args["body-md"] as string | undefined,
      args["body-md-file"] as string | undefined,
    );
    if (bodyMd !== undefined) body.body_md = bodyMd;
    if (args.lifecycle) body.lifecycle = args.lifecycle;
    await postCapture("actions", body);
  },
});

const logCmd = defineCommand({
  meta: {
    name: "log",
    description:
      "Capture a Log — a recorded happening (POST /by-id/<doco_id>/api/logs.json). Use for actual events: commits, deploys, verifications. Past-tense verb, concrete outputs.",
  },
  args: {
    summary: {
      type: "string",
      description: "Required. One-line summary of what happened.",
      required: true,
    },
    scope: {
      type: "string",
      description: "Required. Comma-separated scope names.",
      required: true,
    },
    verb: {
      type: "string",
      description: "Required. Past-tense verb ('pushed', 'deployed', 'verified').",
      required: true,
    },
    "happened-at": {
      type: "string",
      description: "Required. ISO 8601 UTC timestamp of when the event occurred.",
      required: true,
    },
    outputs: {
      type: "string",
      description:
        "Required. JSON object of concrete outputs (commit hash, deploy URL, …). Must be non-empty.",
      required: true,
    },
    "template-id": {
      type: "string",
      description: "Optional. ID of the Action template this Log instances (e.g., 'action_01...').",
    },
    "intent-id": {
      type: "string",
      description: "Optional. Comma-separated intent ids this Log advances.",
    },
    "decision-id": {
      type: "string",
      description: "Optional. Comma-separated decision ids this Log enacts.",
    },
    follows: {
      type: "string",
      description: "Optional. Comma-separated entity ids this Log follows.",
    },
    inputs: { type: "string", description: "Optional JSON for verb-specific inputs." },
    "performed-by-username": {
      type: "string",
      description: "Optional principal username who performed the action.",
    },
    "body-md": { type: "string", description: "Optional markdown body (inline string)." },
    "body-md-file": {
      type: "string",
      description: "Optional path to a file whose contents become body_md.",
    },
    lifecycle: { type: "string", description: "Optional. Defaults to 'succeeded'." },
  },
  async run({ args }) {
    const outputs = parseJson<Record<string, unknown>>(args.outputs as string, "outputs");
    if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
      console.error(cross("--outputs must be a JSON object."));
      process.exit(2);
    }
    const body: Record<string, unknown> = {
      summary: args.summary,
      scope_names: splitList(args.scope as string),
      verb: args.verb,
      happened_at: args["happened-at"],
      outputs,
    };
    if (args["template-id"]) body.template_id = args["template-id"];
    const intents = splitList(args["intent-id"] as string | undefined);
    if (intents.length) body.intent_ids = intents;
    const decisions = splitList(args["decision-id"] as string | undefined);
    if (decisions.length) body.decision_ids = decisions;
    const follows = splitList(args.follows as string | undefined);
    if (follows.length) body.follows = follows;
    const inputs = parseJson<unknown>(args.inputs as string | undefined, "inputs");
    if (inputs !== undefined) body.inputs = inputs;
    if (args["performed-by-username"]) body.performed_by_username = args["performed-by-username"];
    const bodyMd = readBody(
      args["body-md"] as string | undefined,
      args["body-md-file"] as string | undefined,
    );
    if (bodyMd !== undefined) body.body_md = bodyMd;
    if (args.lifecycle) body.lifecycle = args.lifecycle;
    await postCapture("logs", body);
  },
});

const ruleCmd = defineCommand({
  meta: {
    name: "rule",
    description: "Capture a Rule (POST /by-id/<doco_id>/api/rules.json).",
  },
  args: {
    summary: { type: "string", description: "Required. One-line policy summary.", required: true },
    scope: {
      type: "string",
      description: "Required. Comma-separated scope names.",
      required: true,
    },
    predicate: {
      type: "string",
      description: "Required. The machine-checkable / prose predicate the Rule asserts.",
      required: true,
    },
    "intent-id": {
      type: "string",
      description: "Optional. Comma-separated intent ids this rule serves.",
    },
    "enforced-by": {
      type: "string",
      description: "Optional. One of: runtime | review | manual.",
    },
    "born-from": { type: "string", description: "Optional. Decision id this Rule was born from." },
    severity: { type: "string", description: "Optional. One of: hard | soft." },
    "authored-by-username": {
      type: "string",
      description: "Optional principal username who authored the Rule.",
    },
    "body-md": { type: "string", description: "Optional markdown body (inline string)." },
    "body-md-file": {
      type: "string",
      description: "Optional path to a file whose contents become body_md.",
    },
    lifecycle: { type: "string", description: "Optional. Defaults to 'active'." },
  },
  async run({ args }) {
    const enforced = args["enforced-by"] as string | undefined;
    if (enforced && !["runtime", "review", "manual"].includes(enforced)) {
      console.error(
        cross(`--enforced-by must be one of: runtime, review, manual (got '${enforced}').`),
      );
      process.exit(2);
    }
    const severity = args.severity as string | undefined;
    if (severity && !["hard", "soft"].includes(severity)) {
      console.error(cross(`--severity must be one of: hard, soft (got '${severity}').`));
      process.exit(2);
    }
    const body: Record<string, unknown> = {
      summary: args.summary,
      scope_names: splitList(args.scope as string),
      predicate: args.predicate,
    };
    const intents = splitList(args["intent-id"] as string | undefined);
    if (intents.length) body.intent_ids = intents;
    if (enforced) body.enforced_by = enforced;
    if (severity) body.severity = severity;
    if (args["born-from"]) body.born_from = args["born-from"];
    if (args["authored-by-username"]) body.authored_by_username = args["authored-by-username"];
    const bodyMd = readBody(
      args["body-md"] as string | undefined,
      args["body-md-file"] as string | undefined,
    );
    if (bodyMd !== undefined) body.body_md = bodyMd;
    if (args.lifecycle) body.lifecycle = args.lifecycle;
    await postCapture("rules", body);
  },
});

const referenceCmd = defineCommand({
  meta: {
    name: "reference",
    description: "Capture a Reference (POST /by-id/<doco_id>/api/references.json).",
  },
  args: {
    "ref-type": {
      type: "string",
      description: "Required. One of: file | url | ticket | commit | document | other.",
      required: true,
    },
    locator: {
      type: "string",
      description: "Required. The pointer itself — path, URL, ticket id, commit sha, document id.",
      required: true,
    },
    scope: {
      type: "string",
      description: "Required. Comma-separated scope names.",
      required: true,
    },
    summary: {
      type: "string",
      description: "Optional one-line summary; derived from ref-type + locator if absent.",
    },
    "content-hash": {
      type: "string",
      description: "Optional content hash (e.g. sha256 of a file) for change detection.",
    },
    "intent-id": {
      type: "string",
      description: "Optional. Comma-separated intent ids this reference serves.",
    },
    "created-by-username": {
      type: "string",
      description: "Optional principal username who created the reference.",
    },
    "body-md": { type: "string", description: "Optional markdown body (inline string)." },
    "body-md-file": {
      type: "string",
      description: "Optional path to a file whose contents become body_md.",
    },
    lifecycle: { type: "string", description: "Optional. Defaults to 'active'." },
  },
  async run({ args }) {
    const body: Record<string, unknown> = {
      ref_type: args["ref-type"],
      locator: args.locator,
      scope_names: splitList(args.scope as string),
    };
    if (args.summary) body.summary = args.summary;
    if (args["content-hash"]) body.content_hash = args["content-hash"];
    const intents = splitList(args["intent-id"] as string | undefined);
    if (intents.length) body.intent_ids = intents;
    if (args["created-by-username"]) body.created_by_username = args["created-by-username"];
    const bodyMd = readBody(
      args["body-md"] as string | undefined,
      args["body-md-file"] as string | undefined,
    );
    if (bodyMd !== undefined) body.body_md = bodyMd;
    if (args.lifecycle) body.lifecycle = args.lifecycle;
    await postCapture("references", body);
  },
});

const stateCmd = defineCommand({
  meta: {
    name: "state",
    description:
      "Capture a State (POST /by-id/<doco_id>/api/states.json). Per v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG) — a node in a formal state machine. The state-machines template uses these heavily, but any scope can hold States.",
  },
  args: {
    summary: {
      type: "string",
      description: "Required. The State's display name ('paid', 'cart', 'cancelled').",
      required: true,
    },
    scope: {
      type: "string",
      description: "Required. Comma-separated scope names.",
      required: true,
    },
    kind: {
      type: "string",
      description: "Required. One of: initial | intermediate | terminal.",
      required: true,
    },
    invariant: {
      type: "string",
      description:
        "Optional. Comma-separated invariants — observable predicates true while in this State (e.g. 'order.payment.captured = false'). Pass multiple `--invariant` flags or one comma-separated string.",
    },
    follows: {
      type: "string",
      description:
        "Optional. Comma-separated entity ids this State follows (typically the transition Action ids that landed in this State).",
    },
    "created-by-username": {
      type: "string",
      description: "Optional principal username who authored the State.",
    },
    "body-md": { type: "string", description: "Optional markdown body (inline string)." },
    "body-md-file": {
      type: "string",
      description: "Optional path to a file whose contents become body_md.",
    },
    lifecycle: {
      type: "string",
      description:
        "Optional. When unset, the State's lifecycle defaults to the capturing scope's `default_node_lifecycle` (with inheritance) — `drafted` for the state-machines template, otherwise `active`.",
    },
  },
  async run({ args }) {
    const kind = String(args.kind ?? "").trim();
    if (!["initial", "intermediate", "terminal"].includes(kind)) {
      console.error(
        cross(`--kind must be one of: initial, intermediate, terminal (got '${kind}').`),
      );
      process.exit(2);
    }
    const body: Record<string, unknown> = {
      summary: args.summary,
      scope_names: splitList(args.scope as string),
      kind,
    };
    const invariants = splitList(args.invariant as string | undefined);
    if (invariants.length > 0) body.invariants = invariants;
    const follows = splitList(args.follows as string | undefined);
    if (follows.length > 0) body.follows = follows;
    if (args["created-by-username"]) body.created_by_username = args["created-by-username"];
    const bodyMd = readBody(
      args["body-md"] as string | undefined,
      args["body-md-file"] as string | undefined,
    );
    if (bodyMd !== undefined) body.body_md = bodyMd;
    if (args.lifecycle) body.lifecycle = args.lifecycle;
    await postCapture("states", body);
  },
});

export const captureCmd = defineCommand({
  meta: {
    name: "capture",
    description:
      "Capture a node (Intent / Decision / Action / Log / Rule / Eval / Scope / Reference / State) via doco.to's POST endpoints. Reads DOCO_TOKEN from env or ./.env and DOCO_ID from the AGENTS.md header. Prints the response's footer_lines to stdout.",
  },
  subCommands: {
    intent: intentCmd,
    decision: decisionCmd,
    action: actionCmd,
    log: logCmd,
    rule: ruleCmd,
    eval: evalCmd,
    scope: scopeCmd,
    reference: referenceCmd,
    state: stateCmd,
  },
});

// Touch unused import for compile-time happiness when c is referenced in the future.
void c;
