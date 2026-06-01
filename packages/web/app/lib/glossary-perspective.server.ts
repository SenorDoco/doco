// Glossary perspective — server-side data access.
//
// A glossary's "term entries" can be modeled with more than one node
// type. The glossaries template treats a **Decision** as the canonical
// term (`chosen` = headword, `question` = concept, prose = definition,
// `alternatives` = aliases), but real glossaries also define terms as
// **References** (title = headword, prose/citation = definition), and
// the template additionally allows Rules (terminology usage), Evals
// (consistency checks), and an Intent (scope). So this loader reads
// every non-policy content node and reshapes it into a dictionary
// entry, rather than only Decisions — otherwise a glossary built from
// References renders as a blank page.
//
// It reads the same nodes the List perspective shows; only the
// presentation differs, so there is no new write surface here.

import type { PerspectiveWindowSelection } from "./perspective-window.server";
import { windowNodeIds } from "./perspective-window.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

interface NodeRow {
  id: string;
  entity_type: string;
  /** First line of the type-named prose column (the candidate headword). */
  label: string | null;
  /** Full type-named prose column (the candidate definition). */
  prose: string | null;
  lifecycle: string | null;
  data: Record<string, unknown> | null;
  // Reference scalars promoted out of `data` (NULL for other types).
  ref_type: string | null;
  locator: string | null;
  citation: string | null;
  title: string | null;
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
  /** Italic dictionary label: faux part-of-speech for terms, type tag otherwise. */
  tag: string;
  /** The concept question / context the term answers, as an italic lead-in. */
  question: string | null;
  /** Definition prose, split into numbered senses on blank lines. */
  senses: string[];
  /** Source line for cited terms (e.g. a Reference's locator / citation). */
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

/** Drop a leading "<headword>:" / "<headword> —" restatement from a definition. */
function stripHeadwordPrefix(prose: string, headword: string): string {
  const trimmed = prose.trim();
  const head = headword.trim();
  if (!head) return trimmed;
  const re = new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:—–-]\\s*`, "i");
  return trimmed.replace(re, "");
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
 * Faux part-of-speech tag for term headwords (Decisions / References).
 * Headwords are overwhelmingly nouns, so "n." is the honest default;
 * multi-word terms read as phrases and gerunds as verbs. Decorative.
 */
function fauxPartOfSpeech(term: string): string {
  const head = firstLine(term);
  if (!head) return "n.";
  if (/\s/.test(head.trim())) return "phr.";
  if (/ing$/i.test(head)) return "v.";
  if (/ly$/i.test(head)) return "adv.";
  return "n.";
}

// Non-term content types get an honest italic register label instead of
// a faux part-of-speech, so a usage Rule or scope Intent reads correctly.
const TYPE_TAG: Record<string, string> = {
  rule: "usage",
  eval: "check",
  intent: "scope",
};

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

/** Map one content node into a dictionary entry, per its type. */
function toEntry(row: NodeRow, handle: string): GlossaryEntry {
  const data = row.data ?? {};
  const lifecycle = row.lifecycle ?? "asserted";
  let headword: string;
  let question: string | null = null;
  let definitionProse: string;
  let source: string | null = null;
  let alternatives: GlossaryAlternative[] = [];
  let tag: string;

  if (row.entity_type === "decision") {
    headword = asString(data.chosen) ?? asString(data.term) ?? row.label ?? "(untitled term)";
    question = asString(data.question);
    definitionProse = stripHeadwordPrefix(row.prose ?? "", headword);
    alternatives = parseAlternatives(data.alternatives);
    tag = fauxPartOfSpeech(headword);
  } else if (row.entity_type === "reference") {
    // A Reference used as a glossary entry: title is the term, the prose
    // body is the definition, and locator/citation is the source line.
    headword = row.title ?? row.label ?? "(untitled reference)";
    const body = row.title ? (row.prose ?? "") : stripHeadwordPrefix(row.prose ?? "", headword);
    definitionProse = body;
    source = row.citation ?? row.locator ?? null;
    tag = row.ref_type ? row.ref_type.toLowerCase() : "ref.";
    alternatives = parseAlternatives(data.alternatives);
  } else {
    // Rule / Eval / Intent: the first line is the headword, the rest the body.
    headword = row.label ?? "(untitled)";
    definitionProse = stripHeadwordPrefix(row.prose ?? "", headword);
    tag = TYPE_TAG[row.entity_type] ?? row.entity_type;
  }

  return {
    id: row.id,
    href: href(handle, row.entity_type, row.id),
    entityType: row.entity_type,
    headword,
    letter: letterOf(headword),
    pronunciation: pseudoPronunciation(headword),
    tag,
    question,
    senses: splitSenses(definitionProse),
    source,
    alternatives,
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
  // Union the content tables into one shape. Policies (guidance /
  // authoring) and structural Principals are excluded — they're not
  // glossary headwords. Each table projects its type-named prose column
  // into `label` (first line) + `prose` (full text); only references
  // carry the promoted scalar columns.
  // Post-collapse: one `nodes` query over the five glossary node types
  // (decision, reference, rule, eval, intent). Each row's `prose` is the
  // shared prose column; `label` is its first line, except a Reference
  // with a non-empty `title` headwords on the title. The promoted
  // reference scalars (ref_type/locator/citation/title) are NULL for the
  // other four types, exactly as the per-table legs projected.
  const { rows } = await c.query<NodeRow>(
    `
    SELECT id,
           node_type AS entity_type,
           split_part(COALESCE(NULLIF(title, ''), prose), E'\n', 1) AS label,
           prose AS prose,
           COALESCE(lifecycle, 'asserted') AS lifecycle,
           data,
           ref_type, locator, citation, title
      FROM nodes
     WHERE doco_id = $1
       AND node_type IN ('decision', 'reference', 'rule', 'eval', 'intent')
       AND COALESCE(lifecycle, 'asserted') <> 'retired'
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

  return { groups, letters, stats };
}
