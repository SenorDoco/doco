// Glossary perspective — server-side data access.
//
// A glossary's terms are **References**, the one shape the `glossary` template
// admits as a term entry: the prose (`reference`) is the *word being defined* —
// the headword — and the definition lives in the `definition` attribute, off
// the prose, so the node's name stays the bare term. A term cites its source
// inline in `locator` (provenance is a property of the entry, not a separate
// node), and synonyms / deprecated variants live in the `alternatives`
// attribute. So this loader reads every Reference and reshapes it into a
// dictionary entry. (Principals — the stewards the template also admits — are
// not headwords and are not read here.)
//
// It reads the same nodes the List perspective shows; only the presentation
// differs, so there is no new write surface here.

import type { PerspectiveWindowSelection } from "./perspective-window.server";
import { windowNodeIds } from "./perspective-window.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

interface NodeRow {
  id: string;
  entity_type: string;
  /** First line of the prose column (the headword). */
  label: string | null;
  /** Full prose column (the headword; a term's prose is just the word). */
  prose: string | null;
  lifecycle: string | null;
  data: Record<string, unknown> | null;
  // The Reference dedup key (promoted column) — a cited source's source line.
  locator: string | null;
  /** Scalar-subquery total glossary entries (bigint → string from pg). */
  total_count?: number | string | null;
}

interface GlossaryLoadOptions {
  limit?: number;
  window?: PerspectiveWindowSelection;
}

export interface GlossaryAlternative {
  name: string;
  note: string | null;
  /** True when the alternative reads as a rejected / deprecated form. */
  deprecated: boolean;
}

export interface GlossaryEntry {
  id: string;
  href: string;
  entityType: string;
  /** The term — the dictionary headword. */
  headword: string;
  /** Uppercase first letter used for A–Z grouping ("#" when non-alpha). */
  letter: string;
  /** Playful syllabified respelling, e.g. "do·co" → "/ ˈdo · co /"-ish. */
  pronunciation: string;
  /** Italic dictionary label: a faux part-of-speech for the headword. */
  tag: string;
  /** Definition prose, split into numbered senses on blank lines. */
  senses: string[];
  /** Source line for a cited Reference (its `locator`). */
  source: string | null;
  alternatives: GlossaryAlternative[];
  lifecycle: string;
}

export interface GlossaryGroup {
  letter: string;
  entries: GlossaryEntry[];
}

export interface GlossaryPerspectiveData {
  /** Entries grouped by first letter, each group A→Z, entries A→Z. */
  groups: GlossaryGroup[];
  /** Every distinct letter that has at least one entry (for the index). */
  letters: string[];
  /**
   * TRUE total of glossary terms (References) for this Doco, across all
   * lifecycles, counted before the page limit. The header reports loaded
   * (`stats.entries`) vs this total; the sub-stats below describe the loaded
   * slice.
   */
  totalCount: number;
  stats: {
    entries: number;
    defined: number;
    withAliases: number;
    drafting: number;
  };
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeLimit(value: number | null | undefined): number | null {
  if (value == null) return null;
  const limit = Math.floor(value);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

function firstLine(value: string | null | undefined): string {
  return String(value ?? "")
    .split(/\r?\n/, 1)[0]
    .trim();
}

const VOWELS = /[aeiouy]/i;
const DEPRECATED_HINT =
  /\b(deprecat|reject|avoid|legacy|old|former|don'?t use|do not use|banned|outdated|historical|wrong)\b/i;

/**
 * A light, deliberately-approximate syllable respelling. We are not
 * claiming real IPA — this is dictionary *flavor*: chunk the first word
 * on vowel groups, join the chunks with middots, and mark primary
 * stress on the first syllable. Wrapped in slashes like a pronunciation
 * key.
 */
function pseudoPronunciation(term: string): string {
  const word = firstLine(term)
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "");
  const first = word.split(/[\s-]+/).filter(Boolean)[0] ?? "";
  if (first.length < 2) return "";
  const syllables: string[] = [];
  let current = "";
  let lastWasVowel = false;
  for (const ch of first) {
    const isVowel = VOWELS.test(ch);
    if (isVowel && !lastWasVowel && current && VOWELS.test(current)) {
      syllables.push(current);
      current = ch;
    } else {
      current += ch;
    }
    lastWasVowel = isVowel;
  }
  if (current) syllables.push(current);
  if (syllables.length === 0) return "";
  const stressed = syllables.map((syl, i) => (i === 0 ? `ˈ${syl}` : syl)).join(" · ");
  return `/ ${stressed} /`;
}

/**
 * Faux part-of-speech tag for a term headword. Headwords are overwhelmingly
 * nouns, so "n." is the honest default; multi-word terms read as phrases and
 * gerunds as verbs. Decorative.
 */
function fauxPartOfSpeech(term: string): string {
  const head = firstLine(term);
  if (!head) return "n.";
  if (/\s/.test(head.trim())) return "phr.";
  if (/ing$/i.test(head)) return "v.";
  if (/ly$/i.test(head)) return "adv.";
  return "n.";
}

function splitSenses(prose: string): string[] {
  return String(prose ?? "")
    .split(/\n\s*\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function parseAlternatives(value: unknown): GlossaryAlternative[] {
  if (!Array.isArray(value)) return [];
  const out: GlossaryAlternative[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const name = entry.trim();
      if (name) out.push({ name, note: null, deprecated: false });
      continue;
    }
    if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const name = asString(rec.name) ?? asString(rec.term) ?? asString(rec.alias);
      if (!name) continue;
      const note = asString(rec.rejected_because) ?? asString(rec.note) ?? asString(rec.reason);
      const deprecated = Boolean(
        rec.rejected_because || (note ? DEPRECATED_HINT.test(note) : false),
      );
      out.push({ name, note, deprecated });
    }
  }
  return out;
}

function letterOf(headword: string): string {
  const ch = firstLine(headword).charAt(0).toUpperCase();
  return /[A-Z]/.test(ch) ? ch : "#";
}

function href(handle: string, entityType: string, id: string): string {
  return `/${handle}/${entityType}/${id}`;
}

/** Map one Reference into a dictionary entry. */
function toEntry(row: NodeRow, handle: string): GlossaryEntry {
  const data = row.data ?? {};
  const lifecycle = row.lifecycle ?? "active";
  const headword = row.label ?? "(untitled term)";
  const definition = asString(data.definition) ?? "";
  // A term cites its source inline in `locator`; shown as the entry's source
  // line when present.
  const source = row.locator ?? null;
  const tag = fauxPartOfSpeech(headword);

  return {
    id: row.id,
    href: href(handle, row.entity_type, row.id),
    entityType: row.entity_type,
    headword,
    letter: letterOf(headword),
    pronunciation: pseudoPronunciation(headword),
    tag,
    senses: splitSenses(definition),
    source,
    alternatives: parseAlternatives(data.alternatives),
    lifecycle,
  };
}

export async function loadGlossaryPerspectiveData(
  c: QueryClient,
  docoId: string,
  handle: string,
  options: GlossaryLoadOptions = {},
): Promise<GlossaryPerspectiveData> {
  const windowIds = windowNodeIds(options.window);
  const limit = normalizeLimit(options.limit);
  const params: unknown[] = [docoId];
  if (windowIds.length > 0) params.push(windowIds);
  else if (limit != null) params.push(limit);
  // Terms are References. Each row's `prose` is the headword (and `label` its
  // first line); the meaning lives in `extra.definition`, the cited source in
  // the promoted `locator` column.
  //
  // Every lifecycle loads, including retired. Hiding a lifecycle is the
  // client's job: GlossaryPerspective applies the page-level lifecycle filter
  // (`visibleLifecycles`, retired hidden by default). Pre-filtering retired
  // here would make toggling "Retired" on a no-op, leaving a fully-retired
  // glossary blank. Mirrors the Graph/List loader (full-graph.server) and the
  // BPMN loader (PR #819), which both return every lifecycle.
  const { rows } = await c.query<NodeRow>(
    `
    SELECT id,
           node_type AS entity_type,
           split_part(prose, E'\n', 1) AS label,
           prose AS prose,
           COALESCE(lifecycle, 'active') AS lifecycle,
           extra AS data,
           locator,
           (SELECT COUNT(*) FROM nodes
             WHERE doco_id = $1
               AND node_type = 'reference') AS total_count
      FROM nodes
     WHERE doco_id = $1
       AND node_type = 'reference'
       ${windowIds.length > 0 ? "AND id = ANY($2::text[])" : ""}
     ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id ASC
     ${windowIds.length === 0 && limit != null ? "LIMIT $2" : ""}
    `,
    params,
  );

  const entries: GlossaryEntry[] = rows.map((row) => toEntry(row, handle));

  // Alphabetical by headword, case-insensitively — the dictionary order.
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  entries.sort((a, b) => collator.compare(a.headword, b.headword));

  const groupMap = new Map<string, GlossaryEntry[]>();
  for (const entry of entries) {
    if (!groupMap.has(entry.letter)) groupMap.set(entry.letter, []);
    groupMap.get(entry.letter)?.push(entry);
  }

  // Letters A→Z, with "#" (non-alpha headwords) sorted last.
  const letters = [...groupMap.keys()].sort((a, b) => {
    if (a === "#") return 1;
    if (b === "#") return -1;
    return a.localeCompare(b);
  });
  const groups: GlossaryGroup[] = letters.map((letter) => ({
    letter,
    entries: groupMap.get(letter) ?? [],
  }));

  const stats = {
    entries: entries.length,
    defined: entries.filter((e) => e.senses.length > 0).length,
    withAliases: entries.filter((e) => e.alternatives.length > 0).length,
    drafting: entries.filter((e) => e.lifecycle === "drafting").length,
  };
  const totalCount = Number(rows[0]?.total_count ?? 0);

  return { groups, letters, totalCount, stats };
}
