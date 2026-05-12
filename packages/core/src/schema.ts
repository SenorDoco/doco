import { readFile } from "node:fs/promises";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { NodeType } from "@doco/shared";
import { schemaPath } from "./paths.js";

export interface SchemaValidationError {
  path: string;
  message: string;
  keyword: string;
  params: Record<string, unknown>;
}

/**
 * Wraps the JSON Schema at `<doco-root>/schema/doco.schema.json` and validates
 * entities against the right per-type sub-schema (e.g., `principal_entity`).
 */
export class SchemaValidator {
  private validators = new Map<NodeType | "any", ValidateFunction>();

  private constructor(
    public readonly schema: Record<string, unknown>,
    private readonly ajv: Ajv,
  ) {}

  static async load(docoRoot: string): Promise<SchemaValidator> {
    const text = await readFile(schemaPath(docoRoot), "utf8");
    const schema = JSON.parse(text) as Record<string, unknown>;
    return SchemaValidator.fromSchema(schema);
  }

  static fromSchema(schema: Record<string, unknown>): SchemaValidator {
    const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats(ajv);
    ajv.addSchema(schema, "doco");
    return new SchemaValidator(schema, ajv);
  }

  /**
   * Validate an entity. The node_type drives selection of the per-type sub-schema.
   * If type is "any", validates against the top-level oneOf.
   */
  validate(entity: unknown, type: NodeType | "any"): SchemaValidationError[] {
    const fn = this.getValidator(type);
    const ok = fn(entity);
    if (ok) return [];
    return (fn.errors ?? []).map(toError);
  }

  private getValidator(type: NodeType | "any"): ValidateFunction {
    const cached = this.validators.get(type);
    if (cached) return cached;

    let ref: string;
    if (type === "any") {
      ref = "doco";
    } else {
      ref = `doco#/definitions/${type}_entity`;
    }
    const fn = this.ajv.getSchema(ref);
    if (!fn) {
      throw new Error(`No schema definition for type: ${type}`);
    }
    this.validators.set(type, fn);
    return fn;
  }
}

function toError(err: ErrorObject): SchemaValidationError {
  return {
    path: err.instancePath || "/",
    message: err.message ?? "validation failed",
    keyword: err.keyword,
    params: err.params as Record<string, unknown>,
  };
}
