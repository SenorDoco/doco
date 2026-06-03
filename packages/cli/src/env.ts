// Doco config resolution for the CLI. The project coordinate is the
// committed URL(s) in `./.doco/connections.md`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Pull the public Doco coordinate from the project's pointer file.
 * `.doco/connections.md` is a markdown file listing one or more Doco
 * URLs. The first URL wins.
 */
export function readDocoRefFromProject(cwd: string = process.cwd()): string | null {
  try {
    const text = readFileSync(resolve(cwd, ".doco/connections.md"), "utf8");
    const urlMatch = text.match(/https?:\/\/[^/\s)]+\/([A-Za-z0-9][A-Za-z0-9-]*)(?:\/|\b)/);
    if (urlMatch?.[1]) return urlMatch[1];
  } catch {
    return null;
  }
  return null;
}
