// Glossary perspective — server-side data access.
//
// The glossaries template models each term entry as a Decision:
//   • `data.chosen`   — the canonical term (the dictionary headword)
//   • `data.question` — the concept the term answers
//   • `decision`      — the definition prose (scope + examples)
//   • `data.alternatives` — aliases / rejected / deprecated wording
//
// This loader reshapes those Decisions into dictionary entries the
// `GlossaryPerspective` component renders as a printed-lexicon page.
// It reads the same neurons the List perspective shows; only the
// presentation differs, so there is no new write surface here.

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

interface DecisionRow {
  id: string;
  decision: string;
  lifecycle: string | null;
  created_at: string | null;
  data: Record<string, unknown> | null;
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
  /** The canonical term — the dictionary headword. */
  headword: string;
  /** Uppercase first letter used for A–Z grouping ("#" when non-alpha). */
  letter: string;
  /** Playful syllabified respelling, e.g. "do·co" → "/ ˈdoʊ koʊ /"-ish. */
  pronunciation: string;
  /** Faux part-of-speech tag — decorative dictionary flavor. */
  partOfSpeech: string;
  /** The concept question the term answers, shown as an italic lead-in. */
  question: string | null;
  /** Definition prose, split into numbered senses on blank lines. */
  senses: string[];
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
 * claiming real IPA — this is dictionary *flavor*: chunk the word on
 * vowel groups, join the chunks with middots, and mark primary stress
 * on the first syllable. Wrapped in slashes so it reads like a
 * pronunciation key.
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
 * Faux part-of-speech tag. Glossary headwords are overwhelmingly
 * nouns, so "n." is the honest default; multi-word terms read as
 * phrases and gerunds as verbs. Purely decorative.
 */
function partOfSpeech(term: string): string {
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

function href(handle: string, id: string): string {
  return `/${handle}/decision/${id}`;
}

export async function loadGlossaryPerspectiveData(
  c: QueryClient,
  docoId: string,
  handle: string,
): Promise<GlossaryPerspectiveData> {
  const { rows } = await c.query<DecisionRow>(
    `SELECT id, decision, COALESCE(lifecycle, 'accepted') AS lifecycle,
            created_at::text AS created_at, data
       FROM decisions
      WHERE doco_id = $1
        AND COALESCE(lifecycle, 'accepted') <> 'retired'`,
    [docoId],
  );

  const entries: GlossaryEntry[] = rows.map((row) => {
    const data = row.data ?? {};
    const headword =
      asString(data.chosen) ??
      asString(data.term) ??
      (firstLine(row.decision) || "(untitled term)");
    const question = asString(data.question);
    const senses = splitSenses(row.decision);
    return {
      id: row.id,
      href: href(handle, row.id),
      headword,
      letter: letterOf(headword),
      pronunciation: pseudoPronunciation(headword),
      partOfSpeech: partOfSpeech(headword),
      question,
      senses,
      alternatives: parseAlternatives(data.alternatives),
      lifecycle: row.lifecycle ?? "accepted",
    };
  });

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
