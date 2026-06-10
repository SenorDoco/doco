import { describe, expect, it } from "vitest";
import {
  type PerspectiveView,
  perspectiveViewHistoryState,
  perspectiveViewUrl,
  readPerspectiveView,
} from "../perspective-view";

const view = (overrides: Partial<PerspectiveView> = {}): PerspectiveView => ({
  perspective: "graph",
  expandedProcessId: null,
  overlay: { kind: "none" },
  ...overrides,
});

describe("perspectiveViewUrl — one URL per stage", () => {
  it("bare graph perspective is the plain Doco home", () => {
    expect(perspectiveViewUrl("acme", view())).toBe("/acme");
  });

  it("a non-graph perspective carries its slug in ?perspective", () => {
    expect(perspectiveViewUrl("acme", view({ perspective: "process" }))).toBe(
      "/acme?perspective=process",
    );
  });

  it("a drilled process is a focus-only action link (?dialog=skip keeps the overlay shut)", () => {
    expect(
      perspectiveViewUrl("acme", view({ perspective: "process", expandedProcessId: "action_1" })),
    ).toBe("/acme/action/action_1?perspective=process&dialog=skip");
  });

  it("an open node overlay is the node's detail URL", () => {
    expect(
      perspectiveViewUrl(
        "acme",
        view({
          overlay: {
            kind: "node",
            nodeType: "decision",
            id: "decision_1",
            href: "/acme/decision/decision_1",
          },
        }),
      ),
    ).toBe("/acme/decision/decision_1");
  });

  it("a node overlay inside a non-graph perspective keeps the perspective param", () => {
    expect(
      perspectiveViewUrl(
        "acme",
        view({
          perspective: "process",
          overlay: {
            kind: "node",
            nodeType: "decision",
            id: "decision_1",
            href: "/acme/decision/decision_1",
          },
        }),
      ),
    ).toBe("/acme/decision/decision_1?perspective=process");
  });

  it("an open edge overlay is the edge's detail URL", () => {
    expect(
      perspectiveViewUrl(
        "acme",
        view({
          overlay: {
            kind: "edge",
            id: "edge_1",
            source: "n_from",
            target: "n_to",
            href: "/acme/edges/edge_1",
          },
        }),
      ),
    ).toBe("/acme/edges/edge_1");
  });

  it("a pool-header open (drilled AND the process dialog open) shows the dialog, not skip", () => {
    // Clicking a pool header both drills the pool and opens the process
    // Action's overlay. The URL is the dialog URL (no ?dialog=skip); the
    // drilled-pool bit rides along in history state, not the address bar.
    expect(
      perspectiveViewUrl(
        "acme",
        view({
          perspective: "process",
          expandedProcessId: "action_1",
          overlay: {
            kind: "node",
            nodeType: "action",
            id: "action_1",
            href: "/acme/action/action_1",
          },
        }),
      ),
    ).toBe("/acme/action/action_1?perspective=process");
  });
});

describe("perspectiveView history round-trip", () => {
  it("restores a drilled-process stage from its history entry", () => {
    const v = view({ perspective: "process", expandedProcessId: "action_1" });
    expect(readPerspectiveView(perspectiveViewHistoryState(v))).toEqual(v);
  });

  it("restores a node overlay (with its drilled pool) from its history entry", () => {
    const v = view({
      perspective: "process",
      expandedProcessId: "action_1",
      overlay: {
        kind: "node",
        nodeType: "action",
        id: "action_1",
        href: "/acme/action/action_1",
      },
    });
    expect(readPerspectiveView(perspectiveViewHistoryState(v))).toEqual(v);
  });

  it("restores an edge overlay from its history entry", () => {
    const v = view({
      overlay: {
        kind: "edge",
        id: "edge_1",
        source: "n_from",
        target: "n_to",
        href: "/acme/edges/edge_1",
      },
    });
    expect(readPerspectiveView(perspectiveViewHistoryState(v))).toEqual(v);
  });

  it("restores the bare overview stage", () => {
    const v = view({ perspective: "process" });
    expect(readPerspectiveView(perspectiveViewHistoryState(v))).toEqual(v);
  });
});

describe("readPerspectiveView — only OUR entries reconcile", () => {
  it("returns null for React Router's own history entries", () => {
    // RR pushes { usr, key, idx }. Pressing Back across one of those is a
    // real route navigation the loader handles — not ours to reconcile.
    expect(readPerspectiveView({ usr: null, key: "abc", idx: 3 })).toBeNull();
  });

  it("returns null for a stateless entry (null / undefined / empty)", () => {
    expect(readPerspectiveView(null)).toBeNull();
    expect(readPerspectiveView(undefined)).toBeNull();
    expect(readPerspectiveView({})).toBeNull();
  });

  it("returns null for a malformed view marker rather than a blank stage", () => {
    expect(readPerspectiveView({ docoView: 1, perspective: 42 })).toBeNull();
    expect(
      readPerspectiveView({ docoView: 1, perspective: "graph", overlay: { kind: "node" } }),
    ).toBeNull();
  });
});
