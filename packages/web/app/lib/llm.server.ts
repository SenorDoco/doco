import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";

/**
 * Minimal OpenAI client.
 *
 * Uses raw fetch — no SDK dependency. Reads OPENAI_API_KEY from the
 * environment. If the key isn't already set when this module loads, it
 * walks up from the current working directory looking for a `.env` file
 * and loads it via Node 22's built-in `process.loadEnvFile`. That way
 * any caller (web dev server, `doco serve`, future deploy targets)
 * just works without needing the launcher to source `.env` first.
 */

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

// ────────────────────────────────────────────────────────────────────────
// Implicit-edge detection (per the `llm-auto-synapse-detection-on-capture` ADR).
//
// When a new node enters the Doco, ask the LLM to look at the node + a
// summary pool of other nodes in the Doco and propose which existing
// nodes it relates to. Returned synapses are written to the new node's
// `auto_synapses` field with `attribution: 'doco-auto'`.

export interface ImplicitEdgeCandidate {
  id: string;
  entity_type: string;
  summary: string;
  /** Optional name (used by eval) for readable identification in the LLM's response. */
  name?: string;
}

export interface ImplicitEdgeSuggestion {
  to_id: string;
  synapse_type: string;
  reason: string;
}

export interface SuggestImplicitEdgesOptions {
  /** The node we're trying to find connections for. */
  source: { id: string; entity_type: string; summary: string };
  /** Other nodes in the Doco the LLM can pick from. Cap at ~50 in caller. */
  candidates: ImplicitEdgeCandidate[];
  model?: string;
  timeoutMs?: number;
}

const IMPLICIT_EDGE_SYSTEM_PROMPT = `You connect related neurons in a documentation graph.

You'll see one SOURCE neuron and a list of CANDIDATE neurons from the same
project. For each candidate that has a meaningful semantic relationship
to the source, propose ONE synapse.

Synapse types you may use:
- "relates_to" (default — semantically related, no stronger label fits)
- "depends_on" (source needs the candidate to make sense)
- "supports" (candidate provides evidence for the source)
- "contradicts" (candidate disagrees with the source)
- "extends" (candidate is a more specific case of the source)
- "supersedes" (source replaces the candidate)
- "tests" (source is an eval/test of the candidate)

Rules:
- Be conservative — only propose synapses you're confident about. Quality over quantity.
- Maximum 6 synapses. Better to return 2 strong ones than 6 weak ones.
- Each synapse has a one-sentence \`reason\` explaining why.
- Skip synapses already implied by explicit refs (the caller filters those).
- Output JSON only: {"synapses": [{"to_id": "...", "synapse_type": "...", "reason": "..."}, ...]}.`;

export async function suggestImplicitEdges(
  opts: SuggestImplicitEdgesOptions,
): Promise<ImplicitEdgeSuggestion[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || opts.candidates.length === 0) return [];
  const candidatesText = opts.candidates
    .map(
      (c) =>
        `  - id: ${c.id}\n    type: ${c.entity_type}\n${c.name ? `    name: ${c.name}\n` : ""}    summary: ${c.summary}`,
    )
    .join("\n");
  const userPrompt = `SOURCE:
  id: ${opts.source.id}
  entity_type: ${opts.source.entity_type}
  summary: ${opts.source.summary}

CANDIDATES (${opts.candidates.length}):
${candidatesText}`;
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
    const parsed = JSON.parse(text) as { synapses?: unknown };
    if (!Array.isArray(parsed.synapses)) return [];
    const candidateIds = new Set(opts.candidates.map((c) => c.id));
    return (parsed.synapses as Record<string, unknown>[])
      .map((e): ImplicitEdgeSuggestion | null => {
        const to_id = typeof e.to_id === "string" ? e.to_id.trim() : "";
        const synapse_type = typeof e.synapse_type === "string" ? e.synapse_type.trim() : "";
        const reason = typeof e.reason === "string" ? e.reason.trim() : "";
        if (!to_id || !synapse_type || !reason) return null;
        if (!candidateIds.has(to_id)) return null; // hallucinated id
        if (to_id === opts.source.id) return null;
        return { to_id, synapse_type, reason };
      })
      .filter((e): e is ImplicitEdgeSuggestion => e !== null)
      .slice(0, 6);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
