// Lifecycle + node-type badge pills, originally from the BPMN
// perspective. The Graph perspective reuses them so a node's type and
// lifecycle read the same way wherever the node is drawn.
//
// Both badges use the node's lifecycle color as their background — the
// stage controls the color, the label text says what the pill is
// (node type vs lifecycle stage). On a node with multiple badges the
// matching color triplet reinforces the "this lifecycle owns this
// node" reading.

import { Cog, Lightbulb } from "lucide-react";
import type { CSSProperties } from "react";
import { implementationBadgeSpec } from "~/lib/implementation-badge";
import { lifecycleColor, lifecycleLabel, textOnLifecycle } from "~/lib/node-colors";

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
 * Compact human label for a node type. Used inside the type badge,
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

interface ImplementationBadgeProps extends BadgeProps {
  entityType: string;
  /** Whether the node has an implementation reference. */
  implemented: boolean | null | undefined;
}

/**
 * Implementation-status pill: a white gear when the node has an
 * implementation reference, a yellow light bulb when it doesn't. Styled like
 * the type/lifecycle pills (same dark lifecycle background) so it reads as
 * another box in the row, with a tooltip explaining the icon. Renders nothing
 * for node types outside the indicator scope (see `implementationBadgeSpec`).
 */
export function ImplementationBadge({
  entityType,
  lifecycle,
  implemented,
  anchor = "inline",
  className,
}: ImplementationBadgeProps) {
  const spec = implementationBadgeSpec(entityType, implemented);
  if (!spec) return null;
  const Icon = spec.status === "implemented" ? Cog : Lightbulb;
  return (
    <span
      style={{
        ...badgeStyle(lifecycle, anchor),
        display: anchor === "inline" ? "inline-flex" : "flex",
        alignItems: "center",
        justifyContent: "center",
        // Tighter horizontal padding than the text pills so the square glyph
        // reads as an icon chip rather than a one-letter label.
        padding: "2px 4px",
      }}
      className={className}
      title={spec.title}
      aria-label={spec.title}
    >
      <Icon size={11} strokeWidth={2} color={spec.color} aria-hidden="true" />
    </span>
  );
}

/**
 * Tag row centered over the BOTTOM edge of a node — type pill followed
 * by lifecycle pill, both at the same z-level. Paired with
 * `ReferenceNumberBadge` which floats at the TOP edge of the node:
 * the in-graph numbering reads top, the node's identity (type +
 * lifecycle) reads bottom.
 */
interface NodeBadgeRowProps {
  entityType: string;
  lifecycle: string | null | undefined;
  className?: string;
  interactive?: boolean;
  /**
   * Implementation status for the gear / light-bulb indicator. Pass a boolean
   * (the BPMN perspective does) to render the indicator to the right of the
   * lifecycle pill; leave it `undefined` to render no indicator at all — the
   * Graph perspective reuses this row and opts out. The indicator further
   * self-gates by node type (see `implementationBadgeSpec`).
   */
  implemented?: boolean | null;
}

export function NodeBadgeRow({
  entityType,
  lifecycle,
  className,
  interactive = false,
  implemented,
}: NodeBadgeRowProps) {
  const rowStyle: CSSProperties = {
    position: "absolute",
    // Browser-rendered pill height measures ~15.6px (font metrics push it
    // above the 13px the CSS box implies). Bottom = -height/2 = -8 lands
    // the row's vertical center within 0.2px of the card's bottom edge.
    bottom: -8,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 2,
    pointerEvents: interactive ? "auto" : "none",
    cursor: interactive ? "pointer" : undefined,
    display: "flex",
    alignItems: "center",
    gap: 4,
  };
  return (
    <div style={rowStyle} className={className}>
      <TypeBadge entityType={entityType} lifecycle={lifecycle} anchor="inline" />
      <LifecycleBadge lifecycle={lifecycle} anchor="inline" />
      {implemented !== undefined ? (
        <ImplementationBadge
          entityType={entityType}
          lifecycle={lifecycle}
          implemented={implemented}
          anchor="inline"
        />
      ) : null}
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
