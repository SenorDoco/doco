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

export interface JudgeProbabilisticOptions {
  spec: string;
  entity: { id: string; node_type: string; summary: string; body?: string };
  model?: string;
  timeoutMs?: number;
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: true, reason: "No LLM available; deferred." };
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
    if (!res.ok) return { ok: true, reason: "Judge call failed; deferred." };
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (!text) return { ok: true, reason: "Empty judge response; deferred." };
    const parsed = JSON.parse(text) as { ok?: unknown; reason?: unknown };
    return {
      ok: parsed.ok === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason given)",
    };
  } catch {
    return { ok: true, reason: "Judge errored; deferred." };
  } finally {
    clearTimeout(timeout);
  }
}
