import { describe, expect, it } from "vitest";

import {
  focusNavigationUrl,
  focusTargetForCreate,
  focusTargetForNavigateUrl,
  focusTargetForResourcePath,
  pendingCreateForRequest,
  perspectiveParam,
  requestRetiresResource,
} from "../agent-follow-target";

describe("focusTargetForResourcePath", () => {
  it("focuses a node the agent reads or updates by id", () => {
    expect(focusTargetForResourcePath("/acme/api/decisions/decision_01.json")).toEqual({
      pathname: "/acme/decision/decision_01",
      perspectiveAware: true,
    });
  });

  it("focuses an edge the agent reads or updates by id", () => {
    // Edges are first-class rows with their own id-keyed detail route.
    // Centering on an edge means centering the perspective on its source
    // node — the index loader resolves that from the edge URL.
    expect(focusTargetForResourcePath("/acme/api/edges/edge_01.json")).toEqual({
      pathname: "/acme/edges/edge_01",
      perspectiveAware: true,
    });
  });

  it("sends a policy to its standalone editor, which is not perspective-aware", () => {
    expect(focusTargetForResourcePath("/acme/api/policies/policy_01.json")).toEqual({
      pathname: "/acme/policies/policy_01/edit",
      perspectiveAware: false,
    });
  });

  it("ignores collection endpoints (no id) and non-api paths", () => {
    expect(focusTargetForResourcePath("/acme/api/decisions.json")).toBeNull();
    expect(focusTargetForResourcePath("/acme/decision/decision_01")).toBeNull();
  });

  it("ignores unknown plural segments", () => {
    expect(focusTargetForResourcePath("/acme/api/widgets/widget_01.json")).toBeNull();
  });
});

describe("pendingCreateForRequest", () => {
  it("records a node create", () => {
    expect(pendingCreateForRequest("/acme/api/decisions.json", "POST")).toEqual({
      kind: "node",
      handle: "acme",
      entityType: "decision",
    });
  });

  it("records an edge create", () => {
    expect(pendingCreateForRequest("/acme/api/edges.json", "POST")).toEqual({
      kind: "edge",
      handle: "acme",
    });
  });

  it("records a policy create", () => {
    expect(pendingCreateForRequest("/acme/api/policies.json", "POST")).toEqual({
      kind: "policy",
      handle: "acme",
    });
  });

  it("only tracks POSTs to collection endpoints", () => {
    expect(pendingCreateForRequest("/acme/api/decisions.json", "GET")).toBeNull();
    expect(pendingCreateForRequest("/acme/api/decisions/decision_01.json", "POST")).toBeNull();
    expect(pendingCreateForRequest("/acme/api/changesets.json", "POST")).toBeNull();
  });
});

describe("focusTargetForCreate", () => {
  it("focuses a freshly created node", () => {
    expect(
      focusTargetForCreate({ kind: "node", handle: "acme", entityType: "decision" }, "decision_01"),
    ).toEqual({ pathname: "/acme/decision/decision_01", perspectiveAware: true });
  });

  it("focuses a freshly created edge", () => {
    expect(focusTargetForCreate({ kind: "edge", handle: "acme" }, "edge_01")).toEqual({
      pathname: "/acme/edges/edge_01",
      perspectiveAware: true,
    });
  });

  it("opens a freshly created policy in its editor", () => {
    expect(focusTargetForCreate({ kind: "policy", handle: "acme" }, "policy_01")).toEqual({
      pathname: "/acme/policies/policy_01/edit",
      perspectiveAware: false,
    });
  });
});

describe("focusTargetForNavigateUrl", () => {
  it("recognizes a node focus URL", () => {
    expect(focusTargetForNavigateUrl("/acme/decision/decision_01")).toEqual({
      pathname: "/acme/decision/decision_01",
      perspectiveAware: true,
    });
  });

  it("canonicalizes a plural node segment", () => {
    expect(focusTargetForNavigateUrl("/acme/decisions/decision_01")).toEqual({
      pathname: "/acme/decision/decision_01",
      perspectiveAware: true,
    });
  });

  it("recognizes an edge focus URL", () => {
    expect(focusTargetForNavigateUrl("/acme/edges/edge_01")).toEqual({
      pathname: "/acme/edges/edge_01",
      perspectiveAware: true,
    });
  });

  it("leaves non-focus URLs (lists, settings, edge index) alone", () => {
    expect(focusTargetForNavigateUrl("/acme/decisions")).toBeNull();
    expect(focusTargetForNavigateUrl("/acme/settings")).toBeNull();
    expect(focusTargetForNavigateUrl("/acme/edges")).toBeNull();
    expect(focusTargetForNavigateUrl("https://evil.example.com/acme/decision/x")).toBeNull();
  });

  it("tolerates a query string already on the agent's URL", () => {
    expect(focusTargetForNavigateUrl("/acme/decision/decision_01?dialog=skip")).toEqual({
      pathname: "/acme/decision/decision_01",
      perspectiveAware: true,
    });
  });
});

describe("focusNavigationUrl", () => {
  it("carries the active perspective so focus lands in the perspective the user is viewing", () => {
    // The whole point of the feature: focus applies to ALL perspectives,
    // not just the default graph. A user watching BPMN stays on BPMN.
    expect(
      focusNavigationUrl(
        { pathname: "/acme/decision/decision_01", perspectiveAware: true },
        "process",
      ),
    ).toBe("/acme/decision/decision_01?perspective=process&dialog=skip");
  });

  it("carries the active perspective for an edge focus too", () => {
    expect(
      focusNavigationUrl({ pathname: "/acme/edges/edge_01", perspectiveAware: true }, "list"),
    ).toBe("/acme/edges/edge_01?perspective=list&dialog=skip");
  });

  it("omits the perspective param when none is active (default mode)", () => {
    expect(
      focusNavigationUrl({ pathname: "/acme/decision/decision_01", perspectiveAware: true }, null),
    ).toBe("/acme/decision/decision_01?dialog=skip");
  });

  it("never attaches a perspective to a standalone policy editor", () => {
    expect(
      focusNavigationUrl(
        { pathname: "/acme/policies/policy_01/edit", perspectiveAware: false },
        "process",
      ),
    ).toBe("/acme/policies/policy_01/edit?dialog=skip");
  });
});

describe("requestRetiresResource", () => {
  // When the agent makes a node/edge disappear, the camera must NOT
  // auto-focus it: there'd be nothing to look at, and for an edge the
  // focus snaps onto its still-live source node — an unrelated place
  // the user never asked to see. These are the request shapes that
  // mean "this resource is about to vanish".
  it("treats a DELETE as a retire", () => {
    expect(requestRetiresResource("DELETE", undefined)).toBe(true);
    expect(requestRetiresResource("delete", null)).toBe(true);
  });

  it("treats a PATCH/PUT to lifecycle:retired as a retire", () => {
    expect(requestRetiresResource("PATCH", { lifecycle: "retired" })).toBe(true);
    expect(requestRetiresResource("put", { lifecycle: "retired" })).toBe(true);
  });

  it("treats a POST {op:'retire'} as a retire (DELETE-less edge clients)", () => {
    expect(requestRetiresResource("POST", { op: "retire" })).toBe(true);
  });

  it("leaves reads and non-retiring writes alone", () => {
    expect(requestRetiresResource("GET", undefined)).toBe(false);
    expect(requestRetiresResource("PATCH", { lifecycle: "active" })).toBe(false);
    expect(requestRetiresResource("PATCH", { summary: "edit" })).toBe(false);
    expect(requestRetiresResource("POST", { op: "supersede" })).toBe(false);
    expect(requestRetiresResource("POST", {})).toBe(false);
  });
});

describe("perspectiveParam", () => {
  it("reads the active perspective from a search string", () => {
    expect(perspectiveParam("?perspective=process&dialog=skip")).toBe("process");
  });

  it("returns null when no perspective is present", () => {
    expect(perspectiveParam("?dialog=skip")).toBeNull();
    expect(perspectiveParam("")).toBeNull();
  });
});
