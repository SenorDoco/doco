import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ReferenceNumberStoreContext,
  createReferenceNumberStore,
  useReferenceNumber,
} from "../reference-number-store";

describe("createReferenceNumberStore", () => {
  it("returns the number set for an id, and undefined for unknown ids", () => {
    const store = createReferenceNumberStore(
      new Map([
        ["node_a", 1],
        ["node_b", 2],
      ]),
    );
    expect(store.getNumber("node_a")).toBe(1);
    expect(store.getNumber("node_b")).toBe(2);
    expect(store.getNumber("node_missing")).toBeUndefined();
  });

  it("starts empty when no initial map is given", () => {
    const store = createReferenceNumberStore();
    expect(store.getNumber("anything")).toBeUndefined();
  });

  it("notifies subscribers when the numbers actually change", () => {
    const store = createReferenceNumberStore(new Map([["a", 1]]));
    const listener = vi.fn();
    store.subscribe(listener);

    store.setNumbers(new Map([["a", 2]]));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getNumber("a")).toBe(2);

    store.setNumbers(
      new Map([
        ["a", 2],
        ["b", 3],
      ]),
    );
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getNumber("b")).toBe(3);
  });

  it("does NOT notify when the new map is value-equal to the current one", () => {
    const store = createReferenceNumberStore(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const listener = vi.fn();
    store.subscribe(listener);

    // Same entries, different Map identity — the common case while panning
    // when the visible numbering hasn't actually shifted.
    store.setNumbers(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const store = createReferenceNumberStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setNumbers(new Map([["a", 1]]));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.setNumbers(new Map([["a", 9]]));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("useReferenceNumber", () => {
  function Probe({ id }: { id: string }) {
    const number = useReferenceNumber(id);
    return createElement("span", null, number == null ? "none" : `#${number}`);
  }

  it("reads the current number for its id from the surrounding store", () => {
    const store = createReferenceNumberStore(new Map([["node_a", 7]]));
    const html = renderToStaticMarkup(
      createElement(
        ReferenceNumberStoreContext.Provider,
        { value: store },
        createElement(Probe, { id: "node_a" }),
      ),
    );
    expect(html).toContain("#7");
  });

  it("renders nothing meaningful for an id with no number", () => {
    const store = createReferenceNumberStore(new Map([["node_a", 7]]));
    const html = renderToStaticMarkup(
      createElement(
        ReferenceNumberStoreContext.Provider,
        { value: store },
        createElement(Probe, { id: "node_b" }),
      ),
    );
    expect(html).toContain("none");
  });

  it("returns undefined when rendered with no provider", () => {
    const html = renderToStaticMarkup(createElement(Probe, { id: "node_a" }));
    expect(html).toContain("none");
  });
});
