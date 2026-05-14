import * as React from "react";
import { cn } from "~/lib/cn";

export interface ToggleProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "type"> {
  checked: boolean;
  onCheckedChange?: (next: boolean) => void;
  label?: string;
}

export const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, onCheckedChange, label, disabled, className, onClick, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onCheckedChange?.(!checked);
      }}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-primary/40",
        checked ? "border-primary bg-primary" : "border-border bg-input",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
});
