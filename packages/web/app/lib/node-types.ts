import type { NodeType } from "@doco/shared";

/**
 * Single source of truth for per-node-type presentation metadata.
 *
 * Each node type maps to:
 * - `iconName`:   the lucide-react icon component name. The name -> component
 *                 binding lives in `components/node-type-icon.tsx`, the only
 *                 module that may import React/lucide. Storing just the name
 *                 keeps this registry a pure-data, server-safe module so the
 *                 `*.server.ts` consumers can import it without dragging client
 *                 code into the server bundle.
 * - `segment`:    the URL path segment for the type's update endpoint, e.g.
 *                 a decision is updated at `/<doco>/decision/<id>/update`.
 * - `proseField`: the type's primary prose field — the free-text body the
 *                 generic capture factory reads for that type.
 * - `color`:      the per-type accent color (hex) used for node chrome.
 *
 * The four consumers — `node-type-icon.tsx`, `node-detail.server.ts`,
 * `api-capture-factory.server.ts`, `node-colors.ts` — derive their lookups
 * from this one record so the facts can't drift apart.
 */
export interface NodeTypeMeta {
  iconName: string;
  segment: string;
  proseField: string;
  color: string;
}

export const NODE_TYPE_META: Record<NodeType, NodeTypeMeta> = {
  decision: { iconName: "Scale", segment: "decision", proseField: "rationale", color: "#2563eb" },
  intent: { iconName: "GitBranch", segment: "intent", proseField: "description", color: "#7c3aed" },
  action: { iconName: "Play", segment: "action", proseField: "description", color: "#16a34a" },
  rule: { iconName: "ScrollText", segment: "rule", proseField: "statement", color: "#dc2626" },
  log: { iconName: "ScrollText", segment: "log", proseField: "body", color: "#64748b" },
  eval: { iconName: "FlaskConical", segment: "eval", proseField: "summary", color: "#d97706" },
  state: { iconName: "Circle", segment: "state", proseField: "description", color: "#0891b2" },
  idea: { iconName: "Lightbulb", segment: "idea", proseField: "description", color: "#ca8a04" },
  reference_entity: {
    iconName: "BookMarked",
    segment: "reference",
    proseField: "summary",
    color: "#0d9488",
  },
  principal: { iconName: "UserRound", segment: "principal", proseField: "bio", color: "#db2777" },
};
