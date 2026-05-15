/**
 * Minimal OpenAI client for scope suggestions (ADR-082 follow-up).
 *
 * Uses raw fetch — no SDK dependency. Reads OPENAI_API_KEY from the
 * environment (per ADR-079, the key is shared with the Speco project).
 * If the key isn't already set when this module loads, it walks up from
 * the current working directory looking for a `.env` file and loads it
 * via Node 22's built-in `process.loadEnvFile`. That way any caller
 * (web dev server, `doco serve`, future deploy targets) just works
 * without needing the launcher to source `.env` first.
 *
 * Returns [] when the key is missing or the call fails. The form must work
 * even without an LLM available; suggestions are a *helpful add-on*, never
 * the only way to add scopes.
 */
import { loadEnvFile } from "node:process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function loadDotEnvFromAncestors(): void {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      try {
        loadEnvFile(candidate);
      } catch {
        // Malformed .env or older Node; ignore.
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

if (!process.env.OPENAI_API_KEY) loadDotEnvFromAncestors();

export interface ScopeSuggestion {
  name: string;
  purpose: string;
  guidelines: string;
  reasoning: string;
}

export interface SuggestScopesOptions {
  /** What the user is documenting — the more detail, the better. */
  description: string;
  /** Names of scopes that already exist; the LLM will avoid duplicating. */
  existingScopeNames?: string[];
  /** Names of templates the user can tick separately; LLM avoids those too. */
  templateNames?: string[];
  /** Override model (default: gpt-4o-mini for low latency + cost). */
  model?: string;
  /** Override timeout in ms (default 30s). */
  timeoutMs?: number;
}

const SYSTEM_PROMPT = `You design topical scopes for a Doco-tracked project.

Doco is a documentation framework. A "scope" is a topical neighborhood —
anything the user wants to track separately: a feature area, a country,
a team, a customer segment, a regulatory regime, a document type, a
migration project, etc. Scope names are flat tokens (lowercase letters,
digits, underscores, hyphens). For hierarchy, use slashes:
"country/france/payment" is three scopes (country → france → payment).

Each scope you propose carries:
- name: the slug (or slash-path for nested)
- purpose: 1 sentence — what nodes belong inside this scope
- guidelines: 2–4 sentences — how to author nodes into this scope (Decisions,
  Actions, Rules) using Doco's primitives. Be specific about format and
  conventions, not generic.
- reasoning: 1 sentence — why this scope fits the user's project

Rules:
- Propose 5-8 scopes specific to the user's project.
- Avoid generic templates the user can pick separately: user-flows, adrs,
  apis, bugs, runbooks, post-mortems, glossary, roadmap.
- Avoid duplicating any existing scopes.
- Use slash-paths only when there's a real parent-child relationship.
- Output JSON only: {"suggestions": [{name, purpose, guidelines, reasoning}, ...]}.`;

export async function suggestScopes(
  opts: SuggestScopesOptions,
): Promise<ScopeSuggestion[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  const description = opts.description.trim();
  if (description.length < 5) return [];

  const userPrompt =
    `Project description: ${description}\n\n` +
    (opts.existingScopeNames && opts.existingScopeNames.length > 0
      ? `Existing scopes (avoid duplicating): ${opts.existingScopeNames.join(", ")}\n\n`
      : "") +
    (opts.templateNames && opts.templateNames.length > 0
      ? `Templates the user picks separately (avoid these): ${opts.templateNames.join(", ")}\n\n`
      : "") +
    `Propose 5-8 project-specific scopes.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.5,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Don't throw — return empty so the caller falls back gracefully.
      return [];
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return [];
    const parsed = JSON.parse(text) as { suggestions?: unknown };
    if (!Array.isArray(parsed.suggestions)) return [];
    // Validate + normalize each suggestion.
    const NAME_RE = /^[a-z][a-z0-9_-]*(\/[a-z][a-z0-9_-]*)*$/;
    return (parsed.suggestions as Record<string, unknown>[])
      .map((s): ScopeSuggestion | null => {
        const name = typeof s.name === "string" ? s.name.trim() : "";
        const purpose = typeof s.purpose === "string" ? s.purpose.trim() : "";
        const guidelines =
          typeof s.guidelines === "string" ? s.guidelines.trim() : "";
        const reasoning =
          typeof s.reasoning === "string" ? s.reasoning.trim() : "";
        if (!NAME_RE.test(name)) return null;
        if (!purpose || !guidelines) return null;
        return { name, purpose, guidelines, reasoning };
      })
      .filter((s): s is ScopeSuggestion => s !== null)
      .slice(0, 8);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Implicit-edge detection (per the `llm-auto-edge-detection-on-capture` ADR).
//
// When a new node enters the Doco, ask the LLM to look at the node + a
// summary pool of other nodes in the Doco and propose which existing
// nodes it relates to. Returned edges are written to the new node's
// `auto_edges` field with `attribution: 'doco-auto'`.

export interface ImplicitEdgeCandidate {
  id: string;
  node_type: string;
  summary: string;
  /** Optional name (used by scope/eval) for readable identification in the LLM's response. */
  name?: string;
}

export interface ImplicitEdgeSuggestion {
  to_id: string;
  edge_type: string;
  reason: string;
}

export interface SuggestImplicitEdgesOptions {
  /** The node we're trying to find connections for. */
  source: { id: string; node_type: string; summary: string };
  /** Other nodes in the Doco the LLM can pick from. Cap at ~50 in caller. */
  candidates: ImplicitEdgeCandidate[];
  model?: string;
  timeoutMs?: number;
}

const IMPLICIT_EDGE_SYSTEM_PROMPT = `You connect related nodes in a documentation graph.

You'll see one SOURCE node and a list of CANDIDATE nodes from the same
project. For each candidate that has a meaningful semantic relationship
to the source, propose ONE edge.

Edge types you may use:
- "relates_to" (default — semantically related, no stronger label fits)
- "depends_on" (source needs the candidate to make sense)
- "supports" (candidate provides evidence for the source)
- "contradicts" (candidate disagrees with the source)
- "extends" (candidate is a more specific case of the source)
- "supersedes" (source replaces the candidate)
- "tests" (source is an eval/test of the candidate)

Rules:
- Be conservative — only propose edges you're confident about. Quality over quantity.
- Maximum 6 edges. Better to return 2 strong ones than 6 weak ones.
- Each edge has a one-sentence \`reason\` explaining why.
- Skip edges already implied by explicit refs (the caller filters those).
- Output JSON only: {"edges": [{"to_id": "...", "edge_type": "...", "reason": "..."}, ...]}.`;

export async function suggestImplicitEdges(
  opts: SuggestImplicitEdgesOptions,
): Promise<ImplicitEdgeSuggestion[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || opts.candidates.length === 0) return [];
  const userPrompt =
    `SOURCE:\n` +
    `  id: ${opts.source.id}\n` +
    `  node_type: ${opts.source.node_type}\n` +
    `  summary: ${opts.source.summary}\n\n` +
    `CANDIDATES (${opts.candidates.length}):\n` +
    opts.candidates
      .map(
        (c) =>
          `  - id: ${c.id}\n    type: ${c.node_type}\n${c.name ? `    name: ${c.name}\n` : ""}    summary: ${c.summary}`,
      )
      .join("\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? "gpt-4o-mini",
        messages: [
          { role: "system", content: IMPLICIT_EDGE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return [];
    const parsed = JSON.parse(text) as { edges?: unknown };
    if (!Array.isArray(parsed.edges)) return [];
    const candidateIds = new Set(opts.candidates.map((c) => c.id));
    return (parsed.edges as Record<string, unknown>[])
      .map((e): ImplicitEdgeSuggestion | null => {
        const to_id = typeof e.to_id === "string" ? e.to_id.trim() : "";
        const edge_type = typeof e.edge_type === "string" ? e.edge_type.trim() : "";
        const reason = typeof e.reason === "string" ? e.reason.trim() : "";
        if (!to_id || !edge_type || !reason) return null;
        if (!candidateIds.has(to_id)) return null; // hallucinated id
        if (to_id === opts.source.id) return null;
        return { to_id, edge_type, reason };
      })
      .filter((e): e is ImplicitEdgeSuggestion => e !== null)
      .slice(0, 6);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Probabilistic scope-rule judge (per the `scope-membership-rules-engine` ADR).
//
// Takes a free-text spec ("nodes in this scope should reference a concrete
// UI element") and an entity description; returns ok/reason. Used by the
// rules engine to evaluate `{ kind: "probabilistic", spec: "..." }`
// rules.
//
// Two modes:
//   - default (`strict: false`) — soft-fails to `{ok: true}` on missing
//     key / network error / parse error. Caller treats the rule as a
//     deferred warning.
//   - strict (`strict: true`) — throws `LlmUnavailableError` on every
//     failure path. Used by runScopeRules so capture-time probabilistic
//     enforcement REJECTS on LLM unavailability instead of silently passing
//     (decision_01KRPET95G2QNTPCR0YWAKSCH5).

export class LlmUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmUnavailableError";
  }
}

export interface JudgeProbabilisticOptions {
  spec: string;
  entity: { id: string; node_type: string; summary: string; body?: string };
  model?: string;
  timeoutMs?: number;
  /**
   * When true, every failure path throws LlmUnavailableError instead of
   * returning the soft-fail `{ok: true}` shape. Capture-time enforcement
   * passes `strict: true` so an unavailable LLM rejects the write.
   */
  strict?: boolean;
}

export interface JudgeResult {
  ok: boolean;
  reason: string;
}

const JUDGE_SYSTEM_PROMPT = `You judge whether a documentation node meets a written quality criterion.

You get:
- A SPEC: a free-text rule the node must satisfy.
- An ENTITY: the node's id, node_type, summary, and optional body.

Decide whether the entity satisfies the spec. Return JSON only:
{"ok": true | false, "reason": "<one sentence>"}.

Be honest. If you can't tell from the available text, return ok: true with
a reason like "criterion not testable from the visible fields".`;

export async function judgeProbabilisticRule(
  opts: JudgeProbabilisticOptions,
): Promise<JudgeResult> {
  const strict = opts.strict === true;
  const softFail = (reason: string): JudgeResult => {
    if (strict) throw new LlmUnavailableError(reason);
    return { ok: true, reason };
  };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return softFail("OPENAI_API_KEY missing on host.");
  const userPrompt =
    `SPEC: ${opts.spec}\n\n` +
    `ENTITY:\n` +
    `  id: ${opts.entity.id}\n` +
    `  node_type: ${opts.entity.node_type}\n` +
    `  summary: ${opts.entity.summary}\n` +
    (opts.entity.body ? `  body:\n${opts.entity.body.slice(0, 2000)}\n` : "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? "gpt-4o-mini",
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return softFail(`OpenAI judge call failed: HTTP ${res.status}.`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return softFail("Empty judge response from OpenAI.");
    const parsed = JSON.parse(text) as { ok?: unknown; reason?: unknown };
    return {
      ok: parsed.ok === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason given)",
    };
  } catch (e) {
    if (e instanceof LlmUnavailableError) throw e;
    return softFail(`Judge errored: ${(e as Error).message ?? "unknown error"}.`);
  } finally {
    clearTimeout(timeout);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Prose -> ScopeRule[] classifier (decision_01KRPET95G2QNTPCR0YWAKSCH5).
//
// The author types "every Decision should have an Intent, and bugs should
// link to a Rule" — this turns that into TWO ScopeRule rows, classifying
// each as the most-fitting deterministic predicate (requires_edge with
// edge_type=serves + target_node_type=intent; requires_edge with
// edge_type=relates_to + target_node_type=rule). Falls back to
// {kind: "probabilistic", spec: <verbatim>} for prose the predicate
// language can't capture ("the writing is clear", "the rationale is
// concrete"). Always throws on LLM unavailability — both surfaces
// (web preview, API commit) reject the operation instead of silently
// degrading.

export interface ClassifiedRule {
  /** The portion of the original prose this rule represents (verbatim). */
  text: string;
  /** The ScopeRule that will be persisted. Matches the @doco/shared union. */
  rule: ClassifiedScopeRule;
}

/**
 * Mirrors ScopeRule in @doco/shared but typed locally to avoid coupling the
 * web package to that import here. The persistence layer accepts any
 * record-shaped object; the engine reads the discriminant `kind`.
 */
export type ClassifiedScopeRule =
  | {
      kind: "requires_edge" | "forbids_edge";
      edge_type: string;
      target_node_type?: string;
      reason?: string;
    }
  | { kind: "requires_field" | "forbids_field"; fields: string[]; reason?: string }
  | { kind: "mandatory_scope"; scope_ids: string[]; reason?: string }
  | { kind: "probabilistic"; spec: string; reason?: string };

export interface ClassifyRuleProseOptions {
  /** What the project owner typed (may describe multiple rules). */
  prose: string;
  /** Scopes available on this Doco — needed to resolve `mandatory_scope` ids. */
  availableScopes: { id: string; name: string }[];
  /** Name of the scope these rules attach to (informs the LLM's framing). */
  scopeName: string;
  model?: string;
  timeoutMs?: number;
}

// Canonical edge types + node types the engine recognizes. The LLM picks
// from these or falls back to probabilistic — anything off-list would fail
// the rules engine silently.
const CLASSIFIER_EDGE_TYPES = [
  "serves",
  "consults",
  "enacts",
  "performed_by",
  "acts_on",
  "authored_by",
  "premise",
  "concludes",
  "has_parent",
  "has_stakeholder",
  "owned_by",
  "created_by",
  "updated_by",
  "born_from",
  "superseded_by",
  "in_scope_of",
  "member_of",
  "follows",
  "tests",
  "relates_to",
] as const;

const CLASSIFIER_NODE_TYPES = [
  "principal",
  "doco",
  "organization",
  "intent",
  "idea",
  "rule",
  "decision",
  "action",
  "reasoning",
  "eval",
  "reference",
  "scope",
] as const;

const CLASSIFIER_FIELDS = [
  "summary",
  "slug",
  "lifecycle",
  "scopes",
  "intent_ids",
  "decision_ids",
  "rules_consulted",
  "stakeholders",
  "follows",
  "born_from",
  "superseded_by",
  "target_ref",
  "target",
  "actor_id",
  "author_id",
] as const;

const CLASSIFIER_SYSTEM_PROMPT = `You translate plain-English scope rules into the Doco rule engine's typed predicates.

A Scope's "rules" array declares predicates that every node tagged with that scope must satisfy. Deterministic predicates block writes structurally; a probabilistic predicate stores free-text the LLM judges at capture time.

You will see a project owner's prose. Your job:

1. SPLIT the prose into atomic rules. If they wrote "A and B", emit TWO rules.
2. For each atomic rule, pick the MOST FITTING predicate from this list:

   - {kind: "requires_edge", edge_type, target_node_type?}
     Use when the rule is "nodes in this scope must reference X".
     Examples:
       "must have an Intent" -> requires_edge edge_type=serves target_node_type=intent
       "should cite a Decision" -> requires_edge edge_type=enacts target_node_type=decision
       "must link to a Rule" -> requires_edge edge_type=relates_to target_node_type=rule
       "should reference an existing Bug" -> requires_edge edge_type=born_from target_node_type=decision

   - {kind: "forbids_edge", edge_type, target_node_type?}
     Use for the negative form ("must not reference X").

   - {kind: "requires_field", fields[]}
     Use when the rule names a frontmatter property the node must declare.
     Examples:
       "must declare a lifecycle" -> requires_field fields=["lifecycle"]
       "summary and slug are required" -> requires_field fields=["summary", "slug"]

   - {kind: "forbids_field", fields[]}
     Use for the negative form.

   - {kind: "mandatory_scope", scope_ids[]}
     Use ONLY when the rule says "every node in this Doco must also be tagged with scope X".
     The Doco-wide form. You'll get an availableScopes list — resolve scope NAMES to IDs from it. If the named scope isn't in the list, fall back to probabilistic.

   - {kind: "probabilistic", spec}
     Use when the rule asks for a quality judgment that no deterministic predicate captures ("the writing is clear", "the rationale is concrete", "the decision is well-reasoned"). The original prose IS the spec.

3. CONSTRAINTS for deterministic kinds:
   - edge_type MUST be one of: ${CLASSIFIER_EDGE_TYPES.join(", ")}.
   - target_node_type MUST be one of: ${CLASSIFIER_NODE_TYPES.join(", ")}, or omitted.
   - fields MUST be drawn from: ${CLASSIFIER_FIELDS.join(", ")}. If the prose names a field not on this list, fall back to probabilistic.
   - When in doubt -> probabilistic. It is BETTER to defer to the LLM judge than to misclassify into a deterministic kind that won't fire correctly.

4. Each rule also gets a "text" field: the verbatim slice of the user's prose this rule represents. Authors must be able to see their original words in the rule list.

5. Each rule may include a "reason" field (one short sentence) — only when the prose makes the rule's motivation explicit. Otherwise omit.

OUTPUT JSON ONLY in this shape:
{
  "rules": [
    {
      "text": "<verbatim prose slice>",
      "rule": {
        "kind": "requires_edge" | "forbids_edge" | "requires_field" | "forbids_field" | "mandatory_scope" | "probabilistic",
        ...kind-specific params
      }
    }
  ]
}

No commentary. No prose outside the JSON.`;

export async function classifyRuleProse(
  opts: ClassifyRuleProseOptions,
): Promise<ClassifiedRule[]> {
  const prose = opts.prose.trim();
  if (!prose) throw new LlmUnavailableError("Empty prose — nothing to classify.");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new LlmUnavailableError("OPENAI_API_KEY missing on host.");

  const userPrompt =
    `Scope this rule attaches to: ${opts.scopeName}\n\n` +
    `Available scopes on this Doco (for mandatory_scope resolution):\n` +
    opts.availableScopes.map((s) => `  - id: ${s.id}, name: ${s.name}`).join("\n") +
    `\n\nProject owner's prose:\n${prose}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? "gpt-4o-mini",
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new LlmUnavailableError(`OpenAI classifier call failed: HTTP ${res.status}.`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new LlmUnavailableError("Empty classifier response from OpenAI.");
    const parsed = JSON.parse(text) as { rules?: unknown };
    if (!Array.isArray(parsed.rules) || parsed.rules.length === 0) {
      throw new LlmUnavailableError("Classifier returned no rules.");
    }
    return parsed.rules.map(normalizeClassifiedRow).filter((r): r is ClassifiedRule => r !== null);
  } catch (e) {
    if (e instanceof LlmUnavailableError) throw e;
    throw new LlmUnavailableError(
      `Classifier errored: ${(e as Error).message ?? "unknown error"}.`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeClassifiedRow(raw: unknown): ClassifiedRule | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const text = typeof rec.text === "string" ? rec.text.trim() : "";
  if (!text) return null;
  const ruleRaw = rec.rule;
  if (!ruleRaw || typeof ruleRaw !== "object") return null;
  const r = ruleRaw as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : "";
  const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : undefined;
  switch (kind) {
    case "requires_edge":
    case "forbids_edge": {
      const edge_type = typeof r.edge_type === "string" ? r.edge_type : "";
      if (!CLASSIFIER_EDGE_TYPES.includes(edge_type as (typeof CLASSIFIER_EDGE_TYPES)[number])) {
        // Off-list edge type — preserve as probabilistic so capture-time
        // judging still applies. Better a deferred check than a broken one.
        return { text, rule: { kind: "probabilistic", spec: text, ...(reason ? { reason } : {}) } };
      }
      const target_node_type = typeof r.target_node_type === "string" ? r.target_node_type : "";
      const validTarget =
        target_node_type === ""
          ? undefined
          : CLASSIFIER_NODE_TYPES.includes(target_node_type as (typeof CLASSIFIER_NODE_TYPES)[number])
            ? target_node_type
            : null;
      if (validTarget === null) {
        return { text, rule: { kind: "probabilistic", spec: text, ...(reason ? { reason } : {}) } };
      }
      return {
        text,
        rule: {
          kind,
          edge_type,
          ...(validTarget ? { target_node_type: validTarget } : {}),
          ...(reason ? { reason } : {}),
        },
      };
    }
    case "requires_field":
    case "forbids_field": {
      const fieldsRaw = Array.isArray(r.fields) ? r.fields : [];
      const fields = fieldsRaw
        .filter((f): f is string => typeof f === "string" && f.length > 0)
        .filter((f) => CLASSIFIER_FIELDS.includes(f as (typeof CLASSIFIER_FIELDS)[number]));
      if (fields.length === 0) {
        return { text, rule: { kind: "probabilistic", spec: text, ...(reason ? { reason } : {}) } };
      }
      return {
        text,
        rule: { kind, fields: [...new Set(fields)], ...(reason ? { reason } : {}) },
      };
    }
    case "mandatory_scope": {
      const idsRaw = Array.isArray(r.scope_ids) ? r.scope_ids : [];
      const ids = idsRaw.filter(
        (s): s is string => typeof s === "string" && s.startsWith("scope_"),
      );
      if (ids.length === 0) {
        return { text, rule: { kind: "probabilistic", spec: text, ...(reason ? { reason } : {}) } };
      }
      return {
        text,
        rule: { kind, scope_ids: [...new Set(ids)], ...(reason ? { reason } : {}) },
      };
    }
    case "probabilistic": {
      const spec = typeof r.spec === "string" && r.spec.trim() ? r.spec.trim() : text;
      return { text, rule: { kind, spec, ...(reason ? { reason } : {}) } };
    }
    default:
      return { text, rule: { kind: "probabilistic", spec: text, ...(reason ? { reason } : {}) } };
  }
}
