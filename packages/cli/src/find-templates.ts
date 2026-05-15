import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export function findTemplatesDir(start: string, subdir?: string): string {
  let dir = start;
  while (true) {
    const candidate = join(dir, "templates");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return subdir ? join(candidate, subdir) : candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate templates/ walking up from ${start}`);
    }
    dir = parent;
  }
}
