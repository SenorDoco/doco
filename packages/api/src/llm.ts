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
