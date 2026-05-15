// iPhone-style emoji picker bound to a form input. Renders a trigger button
// showing the current emoji (or a placeholder), opens a popover with a search
// box + virtualized emoji grid via `frimousse`, and mirrors the selection into
// a hidden <input name={name}> so existing form POSTs keep working unchanged.
//
// Follows the same "custom popover, site-token styling" approach as the
// recent-searches dropdown on the per-Doco home (decision_01KRHAE0PXVJGD5WD53J24PJQR).
import { useEffect, useId, useRef, useState } from "react";
import { EmojiPicker } from "frimousse";
import { cn } from "~/lib/cn";

export interface EmojiPickerInputProps {
  /** Form field name. Submitted via a hidden input so server handlers see no shape change. */
  name: string;
  /** Initial emoji (or empty string). Uncontrolled — state lives inside the component. */
  defaultValue?: string;
  /** Placeholder emoji shown on the trigger when the value is empty. */
  placeholder?: string;
  /** Width of the trigger button. Tailwind class. */
  triggerWidthClass?: string;
  /** Extra classes applied last to the trigger — useful for matching the
   *  trigger's height to a sibling text input. tailwind-merge resolves
   *  conflicts (e.g. `py-0 text-lg` here will override the defaults). */
  triggerExtraClass?: string;
  /** Optional id for the hidden input (mostly for labels). */
  id?: string;
  /** Optional callback for autosave surfaces. */
  onValueChange?: (value: string) => void;
  /** Whether to render the clear affordance beside the trigger. */
  showClearButton?: boolean;
  /** Accessible label for the trigger. */
  triggerAriaLabel?: string;
}

const POPOVER_WIDTH = 320;
const POPOVER_HEIGHT = 360;
const VIEWPORT_MARGIN = 8;

type Placement = {
  vertical: "top" | "bottom";
  horizontal: "left" | "right";
};

export function EmojiPickerInput({
  name,
  defaultValue = "",
  placeholder = "📔",
  triggerWidthClass = "w-24",
  triggerExtraClass,
  id,
  onValueChange,
  showClearButton = true,
  triggerAriaLabel = "Choose an emoji",
}: EmojiPickerInputProps) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>({
    vertical: "bottom",
    horizontal: "left",
  });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const autoId = useId();
  const hiddenId = id ?? `emoji-${autoId}`;

  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  function commitValue(nextValue: string) {
    setValue(nextValue);
    onValueChange?.(nextValue);
  }

  function computePlacement() {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const spaceRight = window.innerWidth - rect.left - VIEWPORT_MARGIN;
    const spaceLeft = rect.right - VIEWPORT_MARGIN;
    setPlacement({
      vertical:
        spaceBelow >= POPOVER_HEIGHT || spaceBelow >= spaceAbove
          ? "bottom"
          : "top",
      horizontal:
        spaceRight >= POPOVER_WIDTH || spaceRight >= spaceLeft
          ? "left"
          : "right",
    });
  }

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    computePlacement();
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const root = wrapperRef.current;
      if (root && !root.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function onReflow() {
      computePlacement();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-flex items-center gap-1">
      <input type="hidden" id={hiddenId} name={name} value={value} />
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerAriaLabel}
        onClick={toggleOpen}
        className={cn(
          "rounded-md border border-border bg-input px-3 py-2 text-center text-xl outline-none focus:border-primary hover:border-primary",
          triggerWidthClass,
          triggerExtraClass,
        )}
      >
        <span className={value ? "" : "opacity-40"}>{value || placeholder}</span>
      </button>
      {showClearButton && value ? (
        <button
          type="button"
          aria-label="Clear emoji"
          onClick={() => commitValue("")}
          className="flex h-7 w-7 items-center justify-center rounded text-base leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <span aria-hidden>×</span>
        </button>
      ) : null}
      {open ? (
        <div
          role="dialog"
          aria-label="Choose an emoji"
          className={cn(
            "absolute z-20 w-80 overflow-hidden rounded-md border border-border bg-card text-card-foreground shadow-lg",
            placement.vertical === "bottom" ? "top-full mt-1" : "bottom-full mb-1",
            placement.horizontal === "left" ? "left-0" : "right-0",
          )}
        >
          <EmojiPicker.Root
            className="isolate flex h-[340px] w-full flex-col bg-card"
            columns={9}
            onEmojiSelect={({ emoji }) => {
              commitValue(emoji);
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            <div
              className="overflow-hidden border-b border-border p-2"
              style={{ scrollbarGutter: "stable" }}
            >
              <EmojiPicker.Search
                autoFocus
                placeholder="Search emoji…"
                className="w-full rounded-md border border-border bg-input px-3 py-1.5 text-xs text-foreground outline-none focus:border-primary"
              />
            </div>
            <EmojiPicker.Viewport className="relative flex-1 outline-none">
              <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                Loading…
              </EmojiPicker.Loading>
              <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                {({ search }) => <>No emoji found for &ldquo;{search}&rdquo;</>}
              </EmojiPicker.Empty>
              <EmojiPicker.List
                className="select-none pb-2"
                components={{
                  CategoryHeader: ({ category, ...props }) => (
                    <div
                      {...props}
                      className="bg-card px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {category.label}
                    </div>
                  ),
                  Row: ({ children, ...props }) => (
                    <div
                      {...props}
                      className="scroll-my-1.5 px-2"
                      style={{
                        ...props.style,
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(var(--frimousse-list-columns, 9), minmax(0, 1fr))",
                      }}
                    >
                      {children}
                    </div>
                  ),
                  Emoji: ({ emoji, ...props }) => (
                    <button
                      {...props}
                      className={cn(
                        "flex size-7 items-center justify-center rounded text-lg leading-none",
                        emoji.isActive ? "bg-muted" : "",
                      )}
                    >
                      {emoji.emoji}
                    </button>
                  ),
                }}
              />
            </EmojiPicker.Viewport>
          </EmojiPicker.Root>
        </div>
      ) : null}
    </div>
  );
}
