import type { EntityId, NodeType } from "@evalo/shared";
import type { LoadedEvalo } from "./loader.js";
import { findOrphanRefs, type OrphanRef } from "./refs.js";
import { type SchemaValidationError, SchemaValidator } from "./schema.js";

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  source: EntityId | "evalo.yaml" | "load";
  filePath?: string;
  kind: "schema" | "orphan-ref" | "load" | "duplicate-id" | "node-type-mismatch";
  message: string;
  detail?: Record<string, unknown>;
}

export interface ValidationReport {
  totalEntities: number;
  entitiesByType: Record<string, number>;
  schemaErrors: number;
  orphanRefs: number;
  loadFailures: number;
  issues: ValidationIssue[];
  ok: boolean;
}

export async function validateEvalo(
  loaded: LoadedEvalo,
  validator: SchemaValidator,
): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];

  // 1. Load failures from the loader.
  for (const f of loaded.failures) {
    issues.push({
      severity: "error",
      source: "load",
      filePath: f.filePath,
      kind: "load",
      message: f.reason,
    });
  }

  // 2. Schema validation of the Evalo entity itself.
  const evaloErrors = validator.validate(loaded.evalo, "evalo");
  for (const e of evaloErrors) {
    issues.push(makeSchemaIssue("evalo.yaml", undefined, e));
  }

  // 3. Schema validation of every loaded entity.
  for (const [id, le] of loaded.entities) {
    const errs = validator.validate(le.entity, le.entity.node_type as NodeType);
    for (const e of errs) {
      issues.push(makeSchemaIssue(id, le.filePath, e));
    }
  }

  // 4. Orphan-ref detection.
  const orphans = findOrphanRefs(loaded);
  for (const o of orphans) {
    issues.push(makeOrphanIssue(o));
  }

  // 5. Build report.
  const entitiesByType: Record<string, number> = {};
  for (const [t, list] of loaded.byType) {
    entitiesByType[t] = list.length;
  }

  const schemaErrors = issues.filter((i) => i.kind === "schema").length;
  const orphanRefs = issues.filter((i) => i.kind === "orphan-ref").length;
  const loadFailures = issues.filter((i) => i.kind === "load").length;

  return {
    totalEntities: loaded.entities.size,
    entitiesByType,
    schemaErrors,
    orphanRefs,
    loadFailures,
    issues,
    ok: issues.every((i) => i.severity !== "error"),
  };
}

function makeSchemaIssue(
  source: EntityId | "evalo.yaml",
  filePath: string | undefined,
  err: SchemaValidationError,
): ValidationIssue {
  return {
    severity: "error",
    source,
    ...(filePath !== undefined ? { filePath } : {}),
    kind: "schema",
    message: `${err.path || "(root)"} ${err.message}`,
    detail: { keyword: err.keyword, params: err.params },
  };
}

function makeOrphanIssue(o: OrphanRef): ValidationIssue {
  return {
    severity: "error",
    source: o.source,
    kind: "orphan-ref",
    message: `Reference to unknown entity ${o.target} (at ${o.field})`,
    detail: { field: o.field, target: o.target },
  };
}
