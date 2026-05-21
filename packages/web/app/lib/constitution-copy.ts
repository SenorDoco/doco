// Shared copy + helpers for constitution surfaces. Used by:
//   - /new-doco/constitution           (wizard step 2)
//   - /:docoHandle/constitution
//   - /orgs/:orgHandle/constitution
//   - the 4 new-article forms
// Keep them DRY so the wording matches the wizard the project owner
// just walked through.

export const GUIDANCE_ARTICLE_EXPLAINER =
  "Articles AI agents read while working. Not auto-checked — they're a shared agreement.";

export const NODE_AUTHORING_ARTICLE_EXPLAINER =
  "Rules that are automatically evaluated when something is added to Doco.";

export const AGENT_EXPOSURE_NOTE =
  "AI agents are always exposed to both the org's and the doco's articles on every session.";

/**
 * Derive a one-line `summary` from an article body. Project owners
 * write a single article field; the system still needs a short label
 * for list views, search, audit lines, and graph nodes — so the
 * server pulls the first non-blank line (stripped of markdown
 * heading hashes) and caps it at 300 chars.
 */
export function deriveArticleSummary(body: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  const stripped = firstLine.replace(/^#+\s*/, "").trim();
  return stripped.length > 300 ? `${stripped.slice(0, 297)}...` : stripped;
}
