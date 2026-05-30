// Shared copy + helpers for policy surfaces. Used by:
//   - /:docoHandle/policies
//   - the Doco new-policy forms
// Keep them DRY so the wording matches the wizard the project owner
// just walked through.

export const GUIDANCE_POLICY_EXPLAINER =
  "Policies AI agents read while working. Not auto-checked — they're a shared agreement.";

export const NODE_AUTHORING_POLICY_EXPLAINER =
  "Rules that are automatically evaluated when something is added to Doco.";

export const AGENT_EXPOSURE_NOTE =
  "AI agents are always exposed to this Doco's policies on every session.";

/**
 * Derive a one-line `summary` from an article body. Project owners
 * write a single article field; the system still needs a short label
 * for list views, search, audit lines, and graph nodes — so the
 * server pulls the first non-blank line (stripped of markdown
 * heading hashes) and caps it at 300 chars.
 */
export function derivePolicySummary(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  const stripped = firstLine.replace(/^#+\s*/, "").trim();
  return stripped.length > 300 ? `${stripped.slice(0, 297)}...` : stripped;
}

/**
 * Reconstruct the full article text from a row. The `policy` field
 * (renamed from `summary` in migration 038) is the one-line rule
 * statement; `body` is the optional long-form rationale. When body
 * is present the rendered text is `policy\n\nbody` unless body
 * already opens with the policy line.
 */
export function policyFullText(
  row: { policy: string | null | undefined; body: string | null | undefined } | null,
): string {
  if (!row) return "";
  const policy = (row.policy ?? "").trim();
  const body = (row.body ?? "").trim();
  if (!body) return policy;
  if (!policy) return body;
  // New shape: body already opens with the policy line.
  if (body.startsWith(policy)) return body;
  // Stitched shape: policy + body authored separately.
  return `${policy}\n\n${body}`;
}
