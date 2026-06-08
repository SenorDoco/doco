import type { CSSProperties } from "react";

/**
 * The text shown on a process (BPMN) edge. When the edge carries a
 * user-defined condition ("Yes", "If approved", …) that condition is
 * the most informative label. When no condition exists the edge type
 * ("flows_to") fills in so every rendered arrow shows its type.
 */
export function processEdgeLabelText(label: string | null | undefined, edgeType: string): string {
  return label?.trim() || edgeType;
}

/**
 * Max characters per line before a process-arrow tag wraps. The canvas
 * label font is monospace, so a `ch` cap maps one-to-one onto characters:
 * a tag up to this many characters stays on one line, anything longer
 * (e.g. "Verify poster or contact user") breaks onto the next. Tuned so a
 * typical three-or-four-word decision-branch tag lands on two lines rather
 * than stretching into a wide ribbon that overlaps neighboring nodes.
 */
export const EDGE_LABEL_MAX_CH = 16;

/**
 * Visual styling for the pill-shaped tag that rides on a BPMN process
 * arrow. Split out of the perspective component so the wrap rules stay
 * unit-testable without rendering the whole canvas.
 *
 * `stroke` is the arrow's lifecycle color; the pill border inherits it so
 * the tag reads as belonging to its arrow.
 *
 * Note the width cap lives on `labelStyle` (the text span), not on
 * `labelBoxStyle` (the outer pill): `ch` resolves against the element's own
 * font, and only the span carries the monospace label font. A `ch` cap on
 * the box would measure against the inherited canvas font and mis-size.
 */
export function processEdgeLabelStyles(stroke: string): {
  labelBoxStyle: CSSProperties;
  labelStyle: CSSProperties;
} {
  return {
    labelBoxStyle: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      border: `1px solid ${stroke}`,
      borderRadius: 4,
      background: "#ffffff",
      boxShadow: "0 1px 2px rgba(0, 0, 0, 0.12)",
      padding: "2px 6px",
    },
    labelStyle: {
      color: "#202020",
      fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, monospace)",
      fontSize: 9,
      fontWeight: 700,
      // A touch of leading so the two stacked lines of a wrapped tag don't
      // crowd; single-line tags are unaffected to the eye.
      lineHeight: 1.2,
      // Allow wrapping (was "nowrap"); the cap below decides where.
      whiteSpace: "normal",
      maxWidth: `${EDGE_LABEL_MAX_CH}ch`,
      // Center the stacked lines under the arrow midpoint.
      textAlign: "center",
      // Safety net: a single token longer than the cap breaks rather than
      // spilling past the pill. Ordinary multi-word tags break at spaces.
      overflowWrap: "break-word",
    },
  };
}

/**
 * The complete tag payload for a process (BPMN) arrow's React Flow `data`:
 * the tag text, its opacity and z-order, and the pill styling. THIS is the one
 * place every process arrow is labeled — sequence flow, cross-pool boundary,
 * and parent hierarchy alike — so the rule "every rendered arrow shows its type
 * or condition" can't be quietly broken by a construction site that forgets to
 * attach a label. Building an edge's `data` without spreading this in is the
 * bug it exists to prevent.
 *
 * `stroke` is the arrow's lifecycle color (the pill border inherits it);
 * `opacity` is the arrow's render opacity, so the tag fades in lockstep with
 * the line it rides on.
 */
export function processEdgeLabelData(
  label: string | null | undefined,
  edgeType: string,
  stroke: string,
  opacity: number,
): {
  label: string;
  labelOpacity: number;
  labelZIndex: number;
  labelBoxStyle: CSSProperties;
  labelStyle: CSSProperties;
} {
  const { labelBoxStyle, labelStyle } = processEdgeLabelStyles(stroke);
  return {
    label: processEdgeLabelText(label, edgeType),
    labelOpacity: opacity,
    // The tag rides above its arrow so it isn't occluded by a crossing line.
    labelZIndex: 1,
    labelBoxStyle,
    labelStyle,
  };
}
