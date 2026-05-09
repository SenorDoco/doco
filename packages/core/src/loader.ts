import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type EntityId,
  type Entity,
  type Evalo,
  NODE_TYPES,
  type NodeType,
  isEntityId,
  isNodeType,
} from "@evalo/shared";
import { type ParsedEntityFile, readEntityFile } from "./files.js";
import {
  ENTITY_DIRS,
  entityDirPath,
  entityFilenameRegex,
  evaloYamlPath,
} from "./paths.js";

/** A loaded entity together with its on-disk source. */
export interface LoadedEntity {
  entity: Entity;
  filePath: string;
  parsed: ParsedEntityFile;
}

/** A file that looked like it should be an entity but failed to parse / type-check minimally. */
export interface LoadFailure {
  filePath: string;
  reason: string;
}

export interface LoadedEvalo {
  root: string;
  evalo: Evalo;
  entities: Map<EntityId, LoadedEntity>;
  byType: Map<NodeType, LoadedEntity[]>;
  failures: LoadFailure[];
}

/**
 * Walk `<root>/evalo.yaml` plus every entity directory and load every `.md`/`.yaml`/`.json`
 * file matching the `<type>_<ulid>.<ext>` filename pattern. README.md and other navigation
 * aids are silently skipped.
 *
 * This loader does *not* run schema validation — it produces structurally-typed entities.
 * Run `validateEvalo(loaded)` separately for full schema + cross-reference validation.
 */
export async function loadEvalo(root: string): Promise<LoadedEvalo> {
  const failures: LoadFailure[] = [];

  // 1. Load the root evalo.yaml.
  const evaloFile = await readEntityFile(evaloYamlPath(root));
  const evaloData = evaloFile.data as unknown as Evalo;
  if (evaloData?.node_type !== "evalo") {
    throw new Error(
      `evalo.yaml at ${root} does not have node_type: "evalo" (got: ${evaloData?.node_type})`,
    );
  }

  // 2. Walk every entity directory.
  const entities = new Map<EntityId, LoadedEntity>();
  const byType = new Map<NodeType, LoadedEntity[]>();
  for (const t of NODE_TYPES) byType.set(t, []);

  for (const type of NODE_TYPES) {
    if (type === "evalo") continue;
    const spec = ENTITY_DIRS[type];
    const dir = entityDirPath(root, type);
    let exists: boolean;
    try {
      const s = await stat(dir);
      exists = s.isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;

    const filenameRe = entityFilenameRegex(type, spec.format);
    const candidates = spec.partitioned
      ? await listPartitioned(dir, filenameRe)
      : await listDirect(dir, filenameRe);

    for (const filePath of candidates) {
      try {
        const parsed = await readEntityFile(filePath);
        const data = parsed.data as Record<string, unknown>;
        const id = data.id;
        const declaredType = data.node_type;
        if (!isEntityId(id)) {
          failures.push({ filePath, reason: `Missing or malformed 'id' field` });
          continue;
        }
        if (!isNodeType(declaredType) || declaredType !== type) {
          failures.push({
            filePath,
            reason: `node_type "${String(declaredType)}" does not match directory "${type}"`,
          });
          continue;
        }
        const entity = data as unknown as Entity;
        const loaded: LoadedEntity = { entity, filePath, parsed };
        if (entities.has(id as EntityId)) {
          failures.push({ filePath, reason: `Duplicate id: ${id}` });
          continue;
        }
        entities.set(id as EntityId, loaded);
        byType.get(type)?.push(loaded);
      } catch (err) {
        failures.push({
          filePath,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { root, evalo: evaloData, entities, byType, failures };
}

async function listDirect(dir: string, filenameRe: RegExp): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!filenameRe.test(e.name)) continue;
    out.push(join(dir, e.name));
  }
  return out;
}

async function listPartitioned(dir: string, filenameRe: RegExp): Promise<string[]> {
  // Walk one level of subdirectories (e.g. evaluations/2026-05/...).
  const out: string[] = [];
  const top = await readdir(dir, { withFileTypes: true });
  for (const e of top) {
    if (e.isFile() && filenameRe.test(e.name)) {
      // Allow direct files at the top level too.
      out.push(join(dir, e.name));
      continue;
    }
    if (!e.isDirectory()) continue;
    const sub = join(dir, e.name);
    out.push(...(await listDirect(sub, filenameRe)));
  }
  return out;
}
