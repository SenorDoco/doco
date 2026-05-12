// Server-only helpers for the scopes/new route. Lives in *.server.ts so
// node:fs / node:path don't leak into the browser bundle.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface DocoMetadata {
  docoId: string;
  ownerId: string;
  displayName: string;
  description: string;
}

/**
 * Read the new Doco's metadata directly from `doco.yaml` — bypassing the
 * cache db so this works even before the first reindex completes.
 */
export function readDocoMetadata(docoDir: string): DocoMetadata | null {
  try {
    const text = readFileSync(join(docoDir, "doco.yaml"), "utf8");
    const parsed = parseYaml(text) as Record<string, unknown>;
    return {
      docoId: String(parsed.id ?? ""),
      ownerId: String(parsed.owner_id ?? ""),
      displayName: String(parsed.display_name ?? ""),
      description:
        typeof parsed.description === "string" ? parsed.description : "",
    };
  } catch {
    return null;
  }
}

/**
 * List existing scopes by reading `<dir>/scopes/*.yaml`. Returns [] if the
 * directory doesn't exist yet (very fresh Docos).
 */
export function listScopeFiles(docoDir: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  let files: string[];
  try {
    files = readdirSync(join(docoDir, "scopes"));
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".yaml")) continue;
    try {
      const e = parseYaml(readFileSync(join(docoDir, "scopes", f), "utf8")) as Record<
        string,
        unknown
      >;
      out.push({ id: String(e.id), name: String(e.name) });
    } catch {
      // Skip unreadable scope files.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
