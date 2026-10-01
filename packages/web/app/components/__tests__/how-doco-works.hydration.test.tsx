// @vitest-environment happy-dom
//
// The dial turns on its own and when a step is clicked: render on the
// "server", hydrate in a DOM, then drive the timer and a click.
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HowDocoWorks } from "../how-doco-works";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function current(container: HTMLElement): string | undefined {
  return container.querySelector('[aria-current="step"]')?.textContent ?? undefined;
}
function faceTransform(container: HTMLElement): string {
  return container.querySelector<HTMLElement>(".hdw-face")?.style.transform ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  container.innerHTML = renderToString(createElement(HowDocoWorks));
  document.body.appendChild(container);
  await act(async () => {
    hydrateRoot(container, createElement(HowDocoWorks));
  });
  return container;
}

describe("How Doco works dial", () => {
  it("turns to the next step on its own, always clockwise", async () => {
    const container = await mount();
    expect(current(container)).toContain("Collect");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(current(container)).toContain("Connect");
    expect(faceTransform(container)).toBe("rotate(120deg)");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    // Back at Collect after a full lap, a whole turn further on.
    expect(current(container)).toContain("Collect");
    expect(faceTransform(container)).toBe("rotate(360deg)");
  });

  it("turns to a step when it is clicked, and stops turning on its own", async () => {
    const container = await mount();
    const capture = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Capture"),
    );
    await act(async () => {
      capture?.click();
    });
    expect(current(container)).toContain("Capture");
    expect(faceTransform(container)).toBe("rotate(240deg)");
    // The person took over, so the dial stays where they turned it.
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(current(container)).toContain("Capture");
  });
});
