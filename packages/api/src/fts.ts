/**
 * Sanitize free-text input into an FTS5 MATCH query (ADR-075).
 *
 * FTS5's MATCH grammar treats `"`, `(`, `)`, `:`, `^`, `*`, and `+` as
 * operators. Free user text can contain anything; passing it straight to
 * MATCH produces parse errors or unintended boolean queries.
 *
 * Strategy:
 *   - Lowercase the input.
 *   - Replace anything that isn't a word char, hyphen, or whitespace with a
 *     space. Hyphens are kept because tokens like `user-flow` matter.
 *   - Split on whitespace.
 *   - Drop tokens shorter than 3 chars (FTS5 stopwords-ish; cheap noise filter)
 *     or longer than 30 (likely junk like base64 IDs).
 *   - OR the remaining tokens. FTS5 ranks by bm25; one match is enough.
 *
 * Returns an empty string when no tokens survive — callers must treat that
 * as "no query" rather than passing it to MATCH (FTS5 rejects `""`).
 */
export function ftsSanitize(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 30);
  if (tokens.length === 0) return "";
  return tokens.join(" OR ");
}
