import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface GlossaryTerm {
  term: string;
  synonyms: string[];
  description?: string;
}

export class Glossary {
  constructor(private terms: GlossaryTerm[]) {}

  /** Return the glossary's expanded form of a query — keywords + synonyms. */
  expand(query: string): string[] {
    const tokens = tokenize(query);
    const expanded = new Set<string>(tokens);
    for (const t of tokens) {
      for (const term of this.terms) {
        if (term.term.toLowerCase() === t) {
          for (const s of term.synonyms) expanded.add(s.toLowerCase());
        }
        for (const syn of term.synonyms) {
          if (syn.toLowerCase() === t) {
            expanded.add(term.term.toLowerCase());
            for (const s of term.synonyms) expanded.add(s.toLowerCase());
          }
        }
      }
    }
    return [...expanded];
  }

  static async load(evaloRoot: string): Promise<Glossary> {
    const path = join(evaloRoot, "glossary.yaml");
    if (!existsSync(path)) return new Glossary([]);
    const text = await readFile(path, "utf8");
    const parsed = parseYaml(text) as GlossaryTerm[] | null;
    return new Glossary(parsed ?? []);
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}
