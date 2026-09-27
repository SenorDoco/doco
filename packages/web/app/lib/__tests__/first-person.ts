// Doco never speaks in the first person: not in product copy, not in the
// voice its agents are told to use, not in what they write into a doco.
// Tests hold every agent-facing surface and every string Doco says on its
// own behalf to this one regex.
export const FIRST_PERSON =
  /(^|[^A-Za-z'’])(I|I['’](?:m|ll|ve|d)|[Mm]e|[Mm]y|[Mm]ine|[Mm]yself|[Ww]e|[Ww]e['’](?:re|ll|ve|d)|[Uu]s|[Oo]ur|[Oo]urs|[Oo]urselves)(?=[^A-Za-z'’]|$)/;

/** The lines of `text` that use the first person, for a readable failure. */
export function firstPersonLines(text: string): string[] {
  return text.split("\n").filter((line) => FIRST_PERSON.test(line));
}
