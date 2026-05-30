import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { cn } from "~/lib/cn";
import { lifecycleColor } from "~/lib/node-colors";

const badgeVariants = cva(
  "neu-surface inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-mono",
  {
    variants: {
      variant: {
        default: "bg-card text-muted-foreground",
        accent: "text-accent",
        success: "text-success",
        warning: "text-warning",
        destructive: "text-destructive",
        primary: "text-primary",
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
  entityType: string;
}

export function NodeTypeBadge({
  className,
  entityType,
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
      <NodeTypeIcon entityType={entityType} />
      {children ?? entityType}
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
