import { describe, expect, it } from "vitest";
import {
  edgeDialogHistoryState,
  entityTypeFromPathname,
  nodeDialogHistoryState,
  readDialogHistoryState,
} from "../perspective-dialog-history";

describe("perspective dialog history reconciliation", () => {
  it("re-opens the node overlay a node-dialog entry represents", () => {
    const state = nodeDialogHistoryState("decision_01", "decision", "/acme/decision/decision_01");
    expect(readDialogHistoryState(state)).toEqual({
      kind: "node",
      id: "decision_01",
      entityType: "decision",
      href: "/acme/decision/decision_01",
    });
  });

  it("re-opens the edge overlay an edge-dialog entry represents", () => {
    const state = edgeDialogHistoryState("edge_01", "node_from", "node_to", "/acme/edges/edge_01");
    expect(readDialogHistoryState(state)).toEqual({
      kind: "edge",
      id: "edge_01",
      source: "node_from",
      target: "node_to",
      href: "/acme/edges/edge_01",
    });
  });

  it("closes the overlay when the popped entry carries no dialog marker", () => {
    // React Router's own history entries ({ usr, key, idx }) and a plain
    // perspective URL both land here. Pressing Back to the bare
    // perspective must dismiss whatever overlay is open — the bug was
    // that nothing reconciled this, so the URL changed but the overlay
    // stayed stranded on screen.
    expect(readDialogHistoryState({ usr: null, key: "abc", idx: 3 }).kind).toBe("none");
    expect(readDialogHistoryState(null).kind).toBe("none");
    expect(readDialogHistoryState(undefined).kind).toBe("none");
  });

  it("ignores malformed markers rather than opening a blank overlay", () => {
    expect(readDialogHistoryState({ docoNodeDialog: 123 }).kind).toBe("none");
    expect(readDialogHistoryState({ docoEdgeDialog: {} }).kind).toBe("none");
  });

  it("tolerates a node entry that predates the entity-type/href fields", () => {
    // Older entries only stored the id; degrade to empty/null so the
    // handler can still re-open by parsing the entity type from the URL.
    expect(readDialogHistoryState({ docoNodeDialog: "decision_01" })).toEqual({
      kind: "node",
      id: "decision_01",
      entityType: "",
      href: null,
    });
  });

  it("derives the entity type from a node detail pathname", () => {
    expect(entityTypeFromPathname("/acme/decision/decision_01")).toBe("decision");
    expect(entityTypeFromPathname("/acme/principal/principal_01")).toBe("principal");
  });

  it("returns null when the pathname is not an entity detail URL", () => {
    expect(entityTypeFromPathname("/acme")).toBeNull();
    expect(entityTypeFromPathname("/acme/search")).toBeNull();
    expect(entityTypeFromPathname("")).toBeNull();
  });
});
