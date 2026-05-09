import { join } from "node:path";
import type { NodeType } from "@evalo/shared";

export type EntityFileFormat = "yaml" | "md" | "json";

export interface EntityDirSpec {
  dir: string; // relative to evalo root
  format: EntityFileFormat;
  partitioned?: boolean; // evaluations/<YYYY-MM>/<id>.json
}

/**
 * Where each node type's files live, and what format they take. Mirrors SCHEMA.md §2.
 * `evalo` is special-cased — it's at the root as `evalo.yaml`, not a subfolder.
 */
export const ENTITY_DIRS: Record<Exclude<NodeType, "evalo">, EntityDirSpec> = {
  principal: { dir: "principals", format: "yaml" },
  intent: { dir: "intents", format: "md" },
  rule: { dir: "rules", format: "md" },
  decision: { dir: "decisions", format: "md" },
  action: { dir: "actions", format: "md" },
  reasoning: { dir: "reasoning", format: "md" },
  evaluation: { dir: "evaluations", format: "json", partitioned: true },
  reference: { dir: "references", format: "yaml" },
  tag: { dir: "tags", format: "yaml" },
};

/** Filename pattern: `<type>_<ulid>.<ext>`. */
export function entityFilenameRegex(type: NodeType, format: EntityFileFormat): RegExp {
  return new RegExp(`^${type}_[0-9A-HJKMNP-TV-Z]{26}\\.${format}$`);
}

export function evaloYamlPath(root: string): string {
  return join(root, "evalo.yaml");
}

export function schemaPath(root: string): string {
  return join(root, "schema", "evalo.schema.json");
}

export function entityDirPath(root: string, type: Exclude<NodeType, "evalo">): string {
  return join(root, ENTITY_DIRS[type].dir);
}

export function glossaryPath(root: string): string {
  return join(root, "glossary.yaml");
}
