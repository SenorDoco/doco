import * as React from "react";
import { cn } from "~/lib/cn";

export const singleColumnPageMainWidth = "mx-auto w-full max-w-6xl px-6";
export const docoPageMainWidth = "mx-auto w-full max-w-4xl px-6";

export const SingleColumnPageMain = React.forwardRef<
  HTMLElement,
  React.ComponentPropsWithoutRef<"main">
>(({ className, ...props }, ref) => (
  <main ref={ref} className={cn(singleColumnPageMainWidth, className)} {...props} />
));
SingleColumnPageMain.displayName = "SingleColumnPageMain";

export const DocoPageMain = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<"main">>(
  ({ className, ...props }, ref) => (
    <main ref={ref} className={cn(docoPageMainWidth, className)} {...props} />
  ),
);
DocoPageMain.displayName = "DocoPageMain";
