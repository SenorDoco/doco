import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHORING_SURFACE_HEADER, authoringContextForRequest } from "../authoring-source.server";
import { validateAccessToken } from "../oauth-server.server";

vi.mock("../oauth-server.server", () => ({
  validateAccessToken: vi.fn(),
}));

const validateAccessTokenMock = vi.mocked(validateAccessToken);

describe("authoringContextForRequest", () => {
  beforeEach(() => {
    validateAccessTokenMock.mockReset();
  });

  it("classifies normal browser writes as website authoring", async () => {
    const request = new Request("https://doco.test/acme/api/decisions.json", {
      headers: { Cookie: "doco_session=user_01TEST" },
    });

    await expect(authoringContextForRequest(request)).resolves.toEqual({
      source: "ui",
      metadata: { surface: "website" },
    });
  });

  it("classifies in-page Señor Doco writes separately from plain website writes", async () => {
    const request = new Request("https://doco.test/acme/api/decisions.json", {
      headers: {
        Cookie: "doco_session=user_01TEST",
        [AUTHORING_SURFACE_HEADER]: "senor-doco-web",
      },
    });

    await expect(authoringContextForRequest(request)).resolves.toEqual({
      source: "ui",
      metadata: { surface: "senor_doco", client: "website" },
    });
  });

  it("records the OAuth client name for API authoring", async () => {
    validateAccessTokenMock.mockResolvedValue({
      client_name: "Doco MCP Server",
      token_name: "Authoring Verification Token",
    } as Awaited<ReturnType<typeof validateAccessToken>>);
    const request = new Request("https://doco.test/acme/api/decisions.json", {
      headers: { Authorization: "Bearer doco_at_test" },
    });

    await expect(authoringContextForRequest(request)).resolves.toEqual({
      source: "api",
      metadata: {
        auth: "oauth",
        token_name: "Authoring Verification Token",
        client_name: "Doco MCP Server",
      },
    });
    expect(validateAccessTokenMock).toHaveBeenCalledWith("doco_at_test");
  });
});
