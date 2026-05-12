import { join } from "node:path";
import type { NodeType } from "@doco/shared";

export type EntityFileFormat = "yaml" | "md" | "json";

export interface EntityDirSpec {
  dir: string; // relative to doco root
  format: EntityFileFormat;
  partitioned?: boolean; // evaluations/<YYYY-MM>/<id>.json
}

/**
 * Where each node type's files live, and what format they take. Mirrors SCHEMA.md §2.
 * `doco` is special-cased — it's at the root as `doco.yaml`, not a subfolder.
 */
export const ENTITY_DIRS: Record<Exclude<NodeType, "doco">, EntityDirSpec> = {
  intent: { dir: "intents", format: "md" },
  idea: { dir: "ideas", format: "md" },
  rule: { dir: "rules", format: "md" },
  decision: { dir: "decisions", format: "md" },
  action: { dir: "actions", format: "md" },
  reasoning: { dir: "reasoning", format: "md" },
  evaluation: { dir: "evaluations", format: "json", partitioned: true },
  reference: { dir: "references", format: "yaml" },
  scope: { dir: "scopes", format: "yaml" },
};

/** Filename pattern: `<type>_<ulid>.<ext>`. */
export function entityFilenameRegex(type: NodeType, format: EntityFileFormat): RegExp {
  return new RegExp(`^${type}_[0-9A-HJKMNP-TV-Z]{26}\\.${format}$`);
}

export function docoYamlPath(root: string): string {
  return join(root, "doco.yaml");
}

export function schemaPath(root: string): string {
  return join(root, "schema", "doco.schema.json");
}

export function entityDirPath(root: string, type: Exclude<NodeType, "doco">): string {
  return join(root, ENTITY_DIRS[type].dir);
}

export function glossaryPath(root: string): string {
  return join(root, "glossary.yaml");
}
