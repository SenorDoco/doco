import { describe, expect, it, vi } from "vitest";
import { handleNodeDialogLinkClick } from "../node-dialog-link";

function clickEvent(overrides: Record<string, unknown> = {}) {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    currentTarget: { target: "" },
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("handleNodeDialogLinkClick", () => {
  it("intercepts ordinary primary clicks so the page can open an in-place node dialog", () => {
    const event = clickEvent();
    const open = vi.fn();

    const handled = handleNodeDialogLinkClick(event, open);

    expect(handled).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  });

  it("leaves modified clicks alone so browser link affordances still work", () => {
    const event = clickEvent({ metaKey: true });
    const open = vi.fn();

    const handled = handleNodeDialogLinkClick(event, open);

    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
