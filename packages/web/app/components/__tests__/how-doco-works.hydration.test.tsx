// @vitest-environment happy-dom
//
// The diagram moves on to the next step on its own and holds a step that is
// clicked: render on the "server", hydrate in a DOM, then drive the timer
// and a click.
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HowDocoWorks } from "../how-doco-works";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function current(container: HTMLElement): string | undefined {
  return container.querySelector('[aria-current="step"]')?.textContent ?? undefined;
}
function litWires(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".hdw-dia-desktop .hdw-wire.hdw-on")].map(
    (wire) => wire.getAttribute("class")?.replace("hdw-wire ", "").replace(" hdw-on", "") ?? "",
  );
}
/** The chips in play: the sources while they feed the workspace, then the agents. */
function litChips(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".hdw-dia-desktop .hdw-chip.hdw-on")].map(
    (chip) => chip.querySelector("span")?.textContent ?? "",
  );
}
const SOURCES = ["People", "GitHub", "Slack", "Notion", "+ more"];
const AGENTS = ["Claude", "Cursor", "Codex", "Qwen", "+ more"];

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

describe("How Doco works flow", () => {
  it("moves on to the next step on its own and lights that step's wires", async () => {
    const container = await mount();
    expect(current(container)).toContain("Collect");
    expect(new Set(litWires(container))).toEqual(new Set(["hdw-wire-src"]));
    expect(litChips(container)).toEqual(SOURCES);
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(current(container)).toContain("Connect");
    expect(new Set(litWires(container))).toEqual(new Set(["hdw-wire-agent"]));
    expect(litChips(container)).toEqual(AGENTS);
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(current(container)).toContain("Capture");
    expect(new Set(litWires(container))).toEqual(new Set(["hdw-wire-back"]));
    expect(litChips(container)).toEqual(AGENTS);
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    // Back at Collect after the three steps.
    expect(current(container)).toContain("Collect");
  });

  it("holds a step when it is clicked, and stops moving on by itself", async () => {
    const container = await mount();
    const capture = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Capture"),
    );
    await act(async () => {
      capture?.click();
    });
    expect(current(container)).toContain("Capture");
    expect(new Set(litWires(container))).toEqual(new Set(["hdw-wire-back"]));
    // The person took over, so the diagram stays on the step they chose.
    await act(async () => {
      vi.advanceTimersByTime(7000);
    });
    expect(current(container)).toContain("Capture");
  });
});
