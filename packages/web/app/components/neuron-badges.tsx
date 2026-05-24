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
 * Header row that floats over the top edge of a node: reference number
 * (if any), then the type pill, then the lifecycle pill — all in a
 * single inline flow at the same z-level. The reference-number slot is
 * ALWAYS reserved even when there's no number, so toggling the number
 * on/off doesn't shift the pills horizontally.
 *
 * Used by every perspective that draws node cards (Graph, BPMN) so the
 * top-of-card chrome reads the same wherever a node is rendered.
 *
 * `anchor`:
 *   - "left" (default): row hugs the top-left of the host box.
 *   - "centered-top": row centers horizontally over the top edge —
 *     for round / diamond BPMN shapes where a left-anchored row would
 *     sit outside the inscribed shape.
 */
interface NodeBadgeRowProps {
  entityType: string;
  lifecycle: string | null | undefined;
  referenceNumber?: number | null;
  /** Used as the badge's accessible label / tooltip. */
  referenceLabel?: string;
  anchor?: "left" | "centered-top";
  className?: string;
}

const REFERENCE_BADGE_BASE =
  "flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none";

export function NodeBadgeRow({
  entityType,
  lifecycle,
  referenceNumber,
  referenceLabel,
  anchor = "left",
  className,
}: NodeBadgeRowProps) {
  const rowStyle: CSSProperties = {
    position: "absolute",
    top: -10,
    zIndex: 2,
    pointerEvents: "none",
    display: "flex",
    alignItems: "center",
    gap: 4,
    ...(anchor === "centered-top" ? { left: "50%", transform: "translateX(-50%)" } : { left: 6 }),
  };
  return (
    <div style={rowStyle} className={className}>
      {referenceNumber ? (
        <span
          aria-label={
            referenceLabel
              ? `Graph reference #${referenceNumber}: ${referenceLabel}`
              : `Graph reference #${referenceNumber}`
          }
          className={`${REFERENCE_BADGE_BASE} bg-primary text-primary-foreground shadow-sm`}
          title={`Graph reference #${referenceNumber}`}
        >
          #{referenceNumber}
        </span>
      ) : (
        // Empty but space-reserving slot — keeps the type / lifecycle
        // pills in the same horizontal position whether the node is
        // numbered or not.
        <span className={`${REFERENCE_BADGE_BASE} invisible`} aria-hidden="true">
          #0
        </span>
      )}
      <TypeBadge entityType={entityType} lifecycle={lifecycle} anchor="inline" />
      <LifecycleBadge lifecycle={lifecycle} anchor="inline" />
    </div>
  );
}
