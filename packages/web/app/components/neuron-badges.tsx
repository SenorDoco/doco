// Lifecycle + neuron-type badge pills, originally from the BPMN
// perspective. The Graph perspective reuses them so a node's type and
// lifecycle read the same way wherever the node is drawn.
//
// Both badges use the node's lifecycle color as their background — the
// stage controls the color, the label text says what the pill is
// (neuron type vs lifecycle stage). On a node with multiple badges the
// matching color triplet reinforces the "this lifecycle owns this
// neuron" reading.

import type { CSSProperties } from "react";
import { lifecycleColor, lifecycleLabel, textOnLifecycle } from "~/lib/neuron-colors";

export type BadgeAnchor =
  | "left" // sits over the top-left edge of the host box
  | "right" // sits over the top-right edge
  | "centered-top" // top center, half-overlapping
  | "centered-bottom" // bottom center, half-overlapping
  | "inline"; // flows inline with surrounding content; no absolute positioning

interface BadgeProps {
  lifecycle: string | null | undefined;
  anchor?: BadgeAnchor;
  className?: string;
}

interface TypeBadgeProps extends BadgeProps {
  entityType: string;
}

export function badgeStyle(
  lifecycle: string | null | undefined,
  anchor: BadgeAnchor,
): CSSProperties {
  const bg = lifecycleColor(lifecycle);
  const fg = textOnLifecycle(lifecycle);
  const base: CSSProperties = {
    background: bg,
    color: fg,
    fontSize: 9,
    fontWeight: 700,
    lineHeight: 1,
    padding: "2px 5px",
    borderRadius: 3,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
  if (anchor === "inline") {
    return { ...base, display: "inline-block" };
  }
  const positioned: CSSProperties = {
    ...base,
    position: "absolute",
    pointerEvents: "none",
    zIndex: 2,
  };
  switch (anchor) {
    case "left":
      return { ...positioned, top: -7, left: 6 };
    case "right":
      return { ...positioned, top: -7, right: 6 };
    case "centered-top":
      return { ...positioned, top: -8, left: "50%", transform: "translateX(-50%)" };
    case "centered-bottom":
      return { ...positioned, bottom: -8, left: "50%", transform: "translateX(-50%)" };
  }
}

/**
 * Compact human label for a neuron type. Used inside the type badge,
 * where the four-letter pill needs to read fast — "Ref" instead of
 * "reference", etc. The full type string is still available via the
 * surrounding card's data attributes for tooling.
 */
export function labelForType(type: string): string {
  switch (type) {
    case "intent":
      return "Intent";
    case "decision":
      return "Decision";
    case "action":
      return "Action";
    case "rule":
      return "Rule";
    case "state":
      return "State";
    case "log":
      return "Log";
    case "eval":
      return "Eval";
    case "reference":
      return "Ref";
    case "idea":
      return "Idea";
    case "principal":
      return "Principal";
    default:
      return type;
  }
}

export function TypeBadge({ entityType, lifecycle, anchor = "left", className }: TypeBadgeProps) {
  return (
    <span style={badgeStyle(lifecycle, anchor)} className={className}>
      {labelForType(entityType)}
    </span>
  );
}

export function LifecycleBadge({ lifecycle, anchor = "right", className }: BadgeProps) {
  return (
    <span style={badgeStyle(lifecycle, anchor)} className={className}>
      {lifecycleLabel(lifecycle)}
    </span>
  );
}

/**
 * Tag row centered over the BOTTOM edge of a node — type pill followed
 * by lifecycle pill, both at the same z-level. Paired with
 * `ReferenceNumberBadge` which floats at the TOP edge of the node:
 * the in-graph numbering reads top, the neuron's identity (type +
 * lifecycle) reads bottom.
 */
interface NodeBadgeRowProps {
  entityType: string;
  lifecycle: string | null | undefined;
  className?: string;
}

export function NodeBadgeRow({ entityType, lifecycle, className }: NodeBadgeRowProps) {
  const rowStyle: CSSProperties = {
    position: "absolute",
    // Badge is ~13px tall (9px text + 2px×2 padding); centering the row
    // on the card's bottom edge requires bottom ≈ -height/2. -7 leaves
    // half the pill above the line and half below across all
    // perspectives (Graph cards, BPMN shapes).
    bottom: -7,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 2,
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    gap: 4,
  };
  return (
    <div style={rowStyle} className={className}>
      <TypeBadge entityType={entityType} lifecycle={lifecycle} anchor="inline" />
      <LifecycleBadge lifecycle={lifecycle} anchor="inline" />
    </div>
  );
}

/**
 * Reference-number badge centered over the TOP edge of a node.
 * Renders nothing when there's no number.
 */
interface ReferenceNumberBadgeProps {
  referenceNumber?: number | null;
  referenceLabel?: string;
  className?: string;
}

export function ReferenceNumberBadge({
  referenceNumber,
  referenceLabel,
  className,
}: ReferenceNumberBadgeProps) {
  if (!referenceNumber) return null;
  return (
    <span
      aria-label={
        referenceLabel
          ? `Graph reference #${referenceNumber}: ${referenceLabel}`
          : `Graph reference #${referenceNumber}`
      }
      className={`pointer-events-none absolute z-20 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground shadow-sm${className ? ` ${className}` : ""}`}
      style={{ top: -10, left: "50%", transform: "translateX(-50%)" }}
      title={`Graph reference #${referenceNumber}`}
    >
      #{referenceNumber}
    </span>
  );
}
