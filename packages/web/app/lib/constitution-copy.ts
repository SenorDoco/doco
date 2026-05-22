// Shared copy + helpers for constitution surfaces. Used by:
//   - /:docoHandle/constitution
//   - the Doco new-primitive forms
// Keep them DRY so the wording matches the wizard the project owner
// just walked through.

export const GUIDANCE_ARTICLE_EXPLAINER =
  "Primitives AI agents read while working. Not auto-checked — they're a shared agreement.";

export const NODE_AUTHORING_ARTICLE_EXPLAINER =
  "Rules that are automatically evaluated when something is added to Doco.";

export const AGENT_EXPOSURE_NOTE =
  "AI agents are always exposed to this Doco's primitives on every session.";

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

/**
 * Reconstruct the full article text from a row that may have been
 * written under the old (summary + body separate) shape or the new
 * (body contains the full article, summary is derived) shape. Lets
 * the display surfaces render one block without worrying which
 * vintage they're looking at.
 */
export function articleFullText(
  row: { summary: string | null | undefined; body: string | null | undefined } | null,
): string {
  if (!row) return "";
  const summary = (row.summary ?? "").trim();
  const body = (row.body ?? "").trim();
  if (!body) return summary;
  if (!summary) return body;
  // New shape: body already opens with the summary line.
  if (body.startsWith(summary)) return body;
  // Old shape: summary + body were authored separately; stitch them.
  return `${summary}\n\n${body}`;
}
