import type { CSSProperties } from "react";
import { cn } from "~/lib/cn";

/**
 * Evalo brand mark: the favicon icon + the "Evalo" logotype side by side.
 * Gap is 5% of the logotype width (per founder direction). Both SVGs scale
 * to the same `height`; logotype's natural aspect ratio (240.9 / 70.1)
 * drives its rendered width.
 */
const LOGOTYPE_ASPECT = 240.9 / 70.1; // ≈ 3.4366
const GAP_AS_FRACTION_OF_LOGOTYPE_WIDTH = 0.05;

interface EvaloMarkProps {
  height: number;
  className?: string;
}

export function EvaloMark({ height, className }: EvaloMarkProps) {
  const logotypeWidth = height * LOGOTYPE_ASPECT;
  const gapPx = logotypeWidth * GAP_AS_FRACTION_OF_LOGOTYPE_WIDTH;
  const style: CSSProperties = { gap: `${gapPx}px` };
  return (
    <span className={cn("inline-flex items-center", className)} style={style} aria-label="Evalo">
      <img
        src="/favicon.svg"
        alt=""
        aria-hidden="true"
        style={{ height: `${height}px`, width: `${height}px` }}
        className="block"
      />
      <img
        src="/logotype.svg"
        alt="Evalo"
        style={{ height: `${height}px` }}
        className="block w-auto"
      />
    </span>
  );
}
