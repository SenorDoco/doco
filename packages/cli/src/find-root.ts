import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Walk upward from `start` until we find a directory containing `evalo.yaml`.
 * Returns the absolute path to that directory, or null if none was found.
 */
export async function findEvaloRoot(start: string = process.cwd()): Promise<string | null> {
  let dir = resolve(start);
  while (true) {
    try {
      const s = await stat(join(dir, "evalo.yaml"));
      if (s.isFile()) return dir;
    } catch {
      // not here, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
