import * as React from "react";
import { cn } from "~/lib/cn";

// Alexander, 2026-10-07: "448px and 1152 - no 768px." A page that isn't full
// screen is 1152px wide, or 448px when it is one small card (sign in, sign up,
// access denied, a digest link). Pages take their width from these two and
// never set their own.

export const PageMain = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<"main">>(
  ({ className, ...props }, ref) => (
    <main ref={ref} className={cn("mx-auto w-full max-w-6xl px-6", className)} {...props} />
  ),
);
PageMain.displayName = "PageMain";

export const NarrowPageMain = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<"main">>(
  ({ className, ...props }, ref) => (
    <main ref={ref} className={cn("mx-auto w-full max-w-md px-6", className)} {...props} />
  ),
);
NarrowPageMain.displayName = "NarrowPageMain";
