// Client-side validation shared by every form that mints/approves access
// through the GrantPicker: the OAuth + device approval screen, the API-token
// generator, and the "add access" / invite forms.
//
// Historically these forms just disabled their submit button until valid, so
// clicking an incomplete form did nothing and gave no reason. Instead they now
// always submit, call `validateGrantForm`, and — when something is missing —
// block the submit, render the message in the app's destructive style, and
// `focusFirstError` to scroll + focus the first offending field.
//
// `validateGrantForm` is pure so it is unit-testable without a DOM and so all
// callers share the exact same messages and ordering. Errors come back in DOM
// order (the name field sits above the picker), so `errors[0]` is the field to
// reveal first.

export type GrantFormFieldKey = "name" | "grants";

export interface GrantFormFieldError {
  field: GrantFormFieldKey;
  message: string;
}

export const GRANT_REQUIRED_MESSAGE = "Select at least one access grant.";

export function validateGrantForm(input: {
  /** Omit when the form has no name field (e.g. the add-access forms). */
  name?: { value: string; message: string };
  grantCount: number;
}): GrantFormFieldError[] {
  const errors: GrantFormFieldError[] = [];
  if (input.name && !input.name.value.trim()) {
    errors.push({ field: "name", message: input.name.message });
  }
  if (input.grantCount <= 0) {
    errors.push({ field: "grants", message: GRANT_REQUIRED_MESSAGE });
  }
  return errors;
}

function isFocusable(el: HTMLElement): boolean {
  return /^(input|select|button|textarea)$/i.test(el.tagName) || el.hasAttribute("tabindex");
}

/**
 * Scroll the first errored field into view and move focus to it. `anchors`
 * maps each field to its element: a name field's anchor is the input itself
 * (focused directly); the grants anchor is the picker container (we focus its
 * first focusable control). Smooth-scroll first, then focus with
 * `preventScroll` so the two don't fight.
 */
export function focusFirstError(
  field: GrantFormFieldKey,
  anchors: Partial<Record<GrantFormFieldKey, HTMLElement | null>>,
): void {
  const anchor = anchors[field];
  if (!anchor) return;
  anchor.scrollIntoView({ behavior: "smooth", block: "center" });
  const focusTarget = isFocusable(anchor)
    ? anchor
    : anchor.querySelector<HTMLElement>("button, select, input, textarea, [tabindex]");
  focusTarget?.focus({ preventScroll: true });
}
