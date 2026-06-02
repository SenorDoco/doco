import { Fragment } from "react";
import { cn } from "~/lib/cn";
import { type LifecycleCounts, lifecycleCountParts } from "~/lib/node-colors";

/**
 * Renders a node count split by lifecycle stage:
 *   drafting / asserted / retired   (blue / black / red)
 *
 * All three are always shown — even zeros — so each color keeps a
 * stable position. Color is the only thing that distinguishes the
 * stages, matching the project-wide rule that color encodes lifecycle.
 */
export function LifecycleCountsLabel({
  counts,
  className,
}: {
  counts: LifecycleCounts;
  className?: string;
}) {
  const parts = lifecycleCountParts(counts);
  return (
    <span
      className={cn("tabular-nums", className)}
      title="Nodes by lifecycle: drafting, asserted, retired"
    >
      {parts.map((part, i) => (
        <Fragment key={part.lifecycle}>
          {i > 0 ? <span className="text-muted-foreground">{" / "}</span> : null}
          <span style={{ color: part.color }}>{part.count}</span>
        </Fragment>
      ))}
    </span>
  );
}
