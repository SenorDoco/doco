// Single source of truth for the per-node-type facts that were previously
// duplicated as parallel maps keyed by the same nine graph-node types:
//
//   - `segment`    — plural URL path segment for a node's update endpoint,
//                    e.g. a decision is updated at
//                    `/<doco>/api/decisions/<id>.json`. (was UPDATE_SEGMENTS
//                    in node-detail.server.ts)
//   - `proseField` — the type-named prose field the per-type capture function
//                    calls `.trim()` on; the factory uses it to reject a
//                    non-string body with a 400. (was PROSE_FIELD in
//                    api-capture-factory.server.ts)
//
// Pure data (strings only, no React/lucide) so both *.server.ts consumers can
// import it without pulling client code into the server bundle. Keyed by
// `string` — not `NodeType` — to match the original maps' typing exactly:
// both were `Record<string, ...>` and their consumers index them with an
// arbitrary `entityType: string` and fall back when a key is absent. Keeping
// the `string` key preserves those lookups and fallbacks byte-for-byte.
//
// NOTE: the per-type icon (an inline-SVG fragment in components/
// node-type-icon.tsx) is intentionally NOT folded in here: it is JSX, so it
// can't live in this server-safe data module, and its key domain spans
// non-node kinds (doco, organization, tag, policies) that aren't node types.
export interface NodeTypeMeta {
  segment: string;
  proseField: string;
}

export const NODE_TYPE_META: Record<string, NodeTypeMeta> = {
  decision: { segment: "decisions", proseField: "decision" },
  intent: { segment: "intents", proseField: "intent" },
  action: { segment: "actions", proseField: "action" },
  log: { segment: "logs", proseField: "log" },
  rule: { segment: "rules", proseField: "rule" },
  eval: { segment: "evals", proseField: "eval" },
  reference: { segment: "references", proseField: "reference" },
  state: { segment: "states", proseField: "state" },
  idea: { segment: "ideas", proseField: "idea" },
};
