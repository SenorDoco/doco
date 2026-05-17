import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { cn } from "~/lib/cn";
import { lifecycleColor } from "~/lib/node-colors";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-mono transition-colors",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-muted-foreground",
        accent: "border-accent text-accent",
        success: "border-success text-success",
        warning: "border-warning text-warning",
        destructive: "border-destructive text-destructive",
        primary: "border-primary text-primary",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export interface NodeTypeBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  nodeType: string;
}

export function NodeTypeBadge({
  className,
  nodeType,
  style,
  children,
  ...props
}: NodeTypeBadgeProps) {
  return (
    <Badge
      className={cn("gap-1.5 bg-card", className)}
      style={{
        ...style,
      }}
      {...props}
    >
      <NodeTypeIcon nodeType={nodeType} />
      {children ?? nodeType}
    </Badge>
  );
}

export interface LifecycleBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  lifecycle: string;
}

export function LifecycleBadge({
  className,
  lifecycle,
  style,
  children,
  ...props
}: LifecycleBadgeProps) {
  const color = lifecycleColor(lifecycle);
  return (
    <Badge
      className={cn("bg-card text-[10px] uppercase", className)}
      style={{
        borderColor: color,
        backgroundColor: `color-mix(in oklch, ${color} 9%, white)`,
        color,
        ...style,
      }}
      {...props}
    >
      {children ?? `lifecycle: ${lifecycle}`}
    </Badge>
  );
}
