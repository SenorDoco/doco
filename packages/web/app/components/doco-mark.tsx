import type { CSSProperties } from "react";
import { cn } from "~/lib/cn";

/**
 * Doco brand mark: the favicon isotype + the "doco" wordmark side by side.
 * Wordmark renders as inline SVG (Space Mono with stroke for extra heft) so
 * it looks identical regardless of font loading state. Icon is served from
 * `/favicon.svg`.
 */
const GAP_AS_FRACTION_OF_HEIGHT = 0.15;

interface DocoMarkProps {
  height: number;
  className?: string;
}

export function DocoMark({ height, className }: DocoMarkProps) {
  const gapPx = height * GAP_AS_FRACTION_OF_HEIGHT;
  const style: CSSProperties = { gap: `${gapPx}px` };
  // Wordmark SVG: viewBox 240×100, scaled so the cap height roughly matches the
  // icon. The 0.85 factor is the same we used with the text wordmark.
  const wordmarkHeight = height * 0.85;
  const wordmarkWidth = wordmarkHeight * (240 / 100);
  return (
    <span className={cn("inline-flex items-center", className)} style={style} aria-label="Doco">
      <img
        src="/favicon.svg"
        alt=""
        aria-hidden="true"
        style={{ height: `${height}px`, width: `${height}px` }}
        className="block"
      />
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 240 100"
        width={wordmarkWidth}
        height={wordmarkHeight}
        aria-hidden="true"
        className="block"
      >
        <text
          x="0"
          y="78"
          fontFamily="'Space Mono', ui-monospace, monospace"
          fontSize="100"
          fontWeight="400"
          fill="#707A23"
          stroke="#707A23"
          strokeWidth="4.3"
          strokeLinejoin="round"
          textRendering="geometricPrecision"
        >
          doco
        </text>
      </svg>
    </span>
  );
}
