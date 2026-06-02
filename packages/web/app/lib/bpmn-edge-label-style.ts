import type { CSSProperties } from "react";

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
export function bpmnEdgeLabelStyles(stroke: string): {
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
