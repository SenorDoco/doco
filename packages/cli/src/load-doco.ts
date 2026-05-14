// Doco loader for the CLI — reads from Postgres
// (rule_01KRKQDHWNWJAF4YKTMCB2A0D9 — alpha forbids back-compat).
//
// The on-disk `<root>/doco.yaml` is a thin pointer that carries only
// the Doco's id. Entity bodies live in Postgres; we use
// `loadDocoFromPostgres` to construct the same LoadedDoco shape that
// the legacy `loadDoco(root)` used to produce.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LoadedDoco } from "@doco/shared";
import { loadDocoFromPostgres } from "@doco/index";

export async function loadDocoFromRoot(root: string): Promise<LoadedDoco> {
  const yamlPath = join(root, "doco.yaml");
  const fm = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  const id = fm.id;
  if (typeof id !== "string" || !id.startsWith("doco_")) {
    throw new Error(`No usable 'id' in doco.yaml at ${root}.`);
  }
  return loadDocoFromPostgres(root, id);
}
