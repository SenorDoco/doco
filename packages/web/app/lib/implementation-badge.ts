// Implementation-status indicator for the BPMN perspective.
//
// A process "event" node is *implemented* when it points at a Reference
// (typically a GitHub PR) through a `supports` edge tagged
// role=implemented_by — i.e. it has an implementation reference. The canvas
// shows a white gear on implemented nodes and a yellow light bulb on the
// rest, so an author reads at a glance which steps of the process already
// exist in code.
//
// Scope (per project owner): the indicator rides the process steps and the
// policies that map to code — Actions, Decisions, States, Rules, and Evals.
// References ARE the implementation (they can never carry an outgoing
// implemented_by edge), and an Idea's type icon is already a light bulb, so
// both are excluded to avoid a meaningless or doubled glyph.

export type ImplementationStatus = "implemented" | "not_implemented";

export interface ImplementationBadgeSpec {
  status: ImplementationStatus;
  /** Tooltip text — explains what the icon means on hover. */
  title: string;
  /** Icon color: white gear when implemented, yellow bulb when not. */
  color: string;
}

/** Node types that carry the gear / light-bulb implementation indicator. */
export const IMPLEMENTATION_INDICATOR_TYPES: ReadonlySet<string> = new Set([
  "action",
  "decision",
  "state",
  "rule",
  "eval",
]);

// White gear, yellow bulb. The lifecycle pills behind them are always dark
// (blue / black / red), so both colors read with strong contrast.
const GEAR_WHITE = "#ffffff";
const BULB_YELLOW = "#facc15"; // tailwind yellow-400

/**
 * Decide the implementation badge for a node, or `null` when the node type
 * carries no indicator. Missing/null `implemented` counts as not implemented.
 */
export function implementationBadgeSpec(
  entityType: string,
  implemented: boolean | null | undefined,
): ImplementationBadgeSpec | null {
  if (!IMPLEMENTATION_INDICATOR_TYPES.has(entityType)) return null;
  if (implemented) {
    return {
      status: "implemented",
      title: "Implemented — this step has an implementation reference (linked code).",
      color: GEAR_WHITE,
    };
  }
  return {
    status: "not_implemented",
    title: "Not implemented — no implementation reference is linked to this step yet.",
    color: BULB_YELLOW,
  };
}
