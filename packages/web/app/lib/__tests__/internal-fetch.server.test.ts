import { describe, expect, it } from "vitest";
import { getInternalFetchRouteMatch } from "../internal-fetch.server";

describe("internalFetch route registry", () => {
  it("registers static edge API routes ahead of the generic type dispatcher", () => {
    expect(getInternalFetchRouteMatch("/demo/api/edges.json")?.pattern).toBe(
      "/:docoHandle/api/edges.json",
    );
    expect(getInternalFetchRouteMatch("/demo/api/edges/edge_01TEST.json")?.pattern).toBe(
      "/:docoHandle/api/edges/:id.json",
    );
  });

  it("covers agent-reachable JSON endpoints that would otherwise fall back to HTTP", () => {
    const expectedPaths = [
      "/api/v1/brief.json",
      "/api/v1/standing-orders.json",
      "/api/v1/me/preferences.json",
      "/api/v1/feedback-reports.json",
      "/api/v1/users/invite.json",
      "/api/v1/api-keys.json",
      "/api/v1/agent-chat/conversations.json",
      "/api/v1/agent-chat/conversation/conv_01TEST.json",
      "/api/v1/agent-chat/attachments/attachment_01TEST",
      "/api/v1/workspaces/acme/project-tokens.json",
      "/demo/api/github.json",
      "/demo/api/edges.json",
      "/demo/api/edges/edge_01TEST.json",
      "/demo/graph-edge-details.json",
    ];

    expect(expectedPaths.filter((path) => !getInternalFetchRouteMatch(path))).toEqual([]);
  });
});
