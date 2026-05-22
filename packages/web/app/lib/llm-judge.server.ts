/**
 * LLM judge for probabilistic authoring primitives.
 *
 * The pure evaluator in `@doco/shared/authoring-evaluator.ts` cannot
 * resolve `probabilistic` predicates on its own — it emits them as
 * `pending` violations carrying the spec. This module takes that spec
 * + the candidate's frontmatter and asks Claude to render a verdict.
 *
 * Failure-mode contract:
 *   - LLM unavailable (no API key, API error, JSON parse failure) →
 *     returns `null`. Caller demotes the violation to a warning
 *     instead of dropping it or blocking on it.
 *   - LLM says PASS → returns `{ ok: true }`. Caller drops the
 *     violation.
 *   - LLM says FAIL → returns `{ ok: false, reason }`. Caller keeps
 *     the violation with the judge's reason text.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface JudgeResult {
  ok: boolean;
  reason?: string;
}

const SYSTEM_PROMPT = `You are an authoring-primitive judge for a knowledge graph that stores neurons (graph nodes) and primitives (constitution metadata) in a project doco.

You receive two inputs:
1. A SPEC describing a quality predicate the author wants enforced on neurons of a given type.
2. A CANDIDATE — the frontmatter of a neuron that's about to be persisted.

Decide whether the candidate satisfies the spec. Reply with a JSON object: {"ok": true} when it satisfies the spec, or {"ok": false, "reason": "..."} with a single-sentence reason when it does not.

Be conservative. If the candidate plausibly satisfies the spec, pass it. Only fail when the violation is clear from the candidate's text.

Many specs have STEP 1 / STEP 2 logic: STEP 1 is a gate that decides whether the rule applies at all (e.g. "is this Action a compensating path?"); STEP 2 is the actual check. If STEP 1 returns false, the rule passes regardless of STEP 2. Walk these steps carefully.`;

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/**
 * Run an LLM judge against a probabilistic predicate's spec + the
 * candidate's frontmatter. Returns `null` on any unavailability so
 * the caller can degrade gracefully.
 */
export async function judgeProbabilisticPredicate(
  spec: string,
  candidate: Record<string, unknown>,
): Promise<JudgeResult | null> {
  const client = getClient();
  if (!client) return null;

  const model = process.env.DOCO_JUDGE_MODEL ?? "claude-opus-4-7";

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `SPEC:\n${spec}\n\nCANDIDATE:\n${JSON.stringify(candidate, null, 2)}`,
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              ok: {
                type: "boolean",
                description: "True when the candidate satisfies the spec; false otherwise.",
              },
              reason: {
                type: "string",
                description:
                  "One-sentence explanation of the violation. Only meaningful when ok is false.",
              },
            },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;

    const parsed = JSON.parse(textBlock.text) as JudgeResult;
    if (typeof parsed.ok !== "boolean") return null;
    return parsed;
  } catch (err) {
    console.warn(
      "[authoring-judge] LLM call failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
