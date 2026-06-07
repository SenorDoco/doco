import { NODE_CATALOG } from "@doco/shared";

// Server-safe node metadata derived from the shared entity catalog. Kept as a
// tiny web shim so existing `~/lib/node-types` imports do not need to know
// where the low-level catalog lives.
export interface NodeTypeMeta {
  segment: string;
}

export const NODE_TYPE_META: Record<string, NodeTypeMeta> = Object.fromEntries(
  Object.entries(NODE_CATALOG).map(([type, meta]) => [type, { segment: meta.segment }]),
);
