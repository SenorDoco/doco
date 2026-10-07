// @vitest-environment happy-dom
//
// Alexander, 2026-10-07, on the card that replaced the steps once they were
// done: "Go to meta-doco?? I was there. That should be a dialog instead." The
// end of the setup opens over the workspace page and closes with Done, which
// leaves the person on the page without the steps.
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetUpDialog } from "../onboarding-stepper";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const dialog = () => container.querySelector("dialog") as HTMLDialogElement;
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text);

const render = (onClose = () => {}) =>
  act(async () => root.render(<SetUpDialog workspaceHandle="acme" onClose={onClose} />));

describe("SetUpDialog", () => {
  it("opens as a modal saying the workspace is set up, with Done in focus", async () => {
    await render();
    expect(dialog().open).toBe(true);
    expect(dialog().textContent).toContain("acme is set up");
    expect(dialog().textContent).toContain("Your agent is working in Doco");
    expect(document.activeElement).toBe(button("Done"));
    // Nothing sends the person to the page they are already on.
    expect(dialog().textContent).not.toContain("Go to acme");
    expect(dialog().querySelector("a")).toBeNull();
  });

  it("closes with Done", async () => {
    const onClose = vi.fn();
    await render(onClose);
    await act(async () => button("Done")?.click());
    expect(dialog().open).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });
});
